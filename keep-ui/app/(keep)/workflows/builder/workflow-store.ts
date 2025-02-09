import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Edge,
} from "@xyflow/react";
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import {
  Definition,
  ValidatorConfigurationV2,
  ToolboxConfiguration,
} from "./types";
import { V2Properties, V2Step, FlowNode } from "./builder-store";
import {
  DefinitionV2,
  getDefinitionFromNodesEdgesProperties,
  getToolboxConfiguration,
} from "./utils";
import { processWorkflowV2 } from "utils/reactFlow";
import { debounce } from "lodash";
import { v4 as uuidv4 } from "uuid";
import { workflowsApi } from "@/shared/api/workflows-client";
import { stepValidatorV2, globalValidatorV2 } from "./builder-validators";
import { parseWorkflow, generateWorkflow } from "./utils";
import { wrapDefinitionV2 } from "./utils";
import { YAMLException } from "js-yaml";
import { Provider } from "../../providers/providers";
import dagre, { graphlib } from "@dagrejs/dagre";

const { createWorkflow, updateWorkflow } = workflowsApi;

interface WorkflowStore {
  // Core Flow State (from FlowState)
  nodes: FlowNode[];
  edges: Edge[];
  v2Properties: V2Properties;
  definition: DefinitionV2;
  changes: number;

  // UI State (from FlowState)
  selectedNode: string | null;
  selectedEdge: string | null;
  errorNode: string | null;
  openGlobalEditor: boolean;
  stepEditorOpenForNode: string | null;
  toolboxConfiguration: ToolboxConfiguration;
  isLayouted: boolean;
  isSaving: boolean;

  // Sync State (from FlowState + new)
  isPendingSync: boolean;
  lastSyncedAt: number;
  canDeploy: boolean;

  // Flow Actions
  updateNodes: (nodes: FlowNode[]) => void;
  updateEdges: (edges: Edge[]) => void;
  updateV2Properties: (properties: V2Properties) => Promise<void>;
  getNodeById: (id: string | null) => FlowNode | undefined;
  getEdgeById: (id: string) => Edge | undefined;
  getNextEdge: (nodeId: string) => Edge | null;

  // Node/Edge Management
  deleteNodes: (ids: string | string[]) => void;
  deleteEdges: (ids: string | string[]) => void;
  updateNode: (node: FlowNode) => void;
  updateEdge: (id: string, key: string, value: any) => void;
  duplicateNode: (node: FlowNode) => void;
  addNodeBetween: (
    nodeOrEdge: string | null,
    step: V2Step,
    type: string
  ) => void;

  // UI Actions
  setSelectedNode: (id: string | null) => void;
  setSelectedEdge: (id: string | null) => void;
  setErrorNode: (id: string | null) => void;
  setOpenGlobalEditor: (open: boolean) => void;
  setStepEditorOpenForNode: (nodeId: string | null) => void;
  setIsLayouted: (isLayouted: boolean) => void;

  // Validation
  validateStep: (step: V2Step, parent?: V2Step) => boolean;
  validateWorkflow: () => boolean;
  validationErrors: {
    step: string | null;
    global: string | null;
  };
  stepValidationError: string | null;
  globalValidationError: string | null;

  // Workflow Actions
  saveWorkflow: () => Promise<void>;

  // Lifecycle
  initialize: (yamlString: string, providers: Provider[]) => void;
  cleanup: () => void;

  // Internal Actions
  updateDefinition: ReturnType<typeof debounce>;

  // Add validator config to state
  validatorConfigurationV2: ValidatorConfigurationV2;

  // Add new method for empty workflow creation
  initializeEmpty: (options?: {
    alertName?: string;
    alertSource?: string;
    workflowId?: string;
  }) => void;

  // Node Data Updates
  updateSelectedNodeData: (key: string, value: any) => void;

  // Flow Operations
  setNodes: (nodes: FlowNode[]) => void;
  setEdges: (edges: Edge[]) => void;
  onNodesChange: (changes: any) => void;
  onEdgesChange: (changes: any) => void;
  onConnect: (connection: any) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (
    event: React.DragEvent,
    getPosition: () => { x: number; y: number }
  ) => void;
  setToolBoxConfig: (config: any) => void;

  // Test Run State
  runRequestCount: number;

  // Test Run Actions
  triggerTestRun: () => void;

  // Layout Operations
  onLayout: (options: {
    direction: string;
    useInitialNodes?: boolean;
    initialNodes?: FlowNode[];
    initialEdges?: Edge[];
  }) => void;
  getLayoutedElements: (
    nodes: FlowNode[],
    edges: Edge[],
    options?: any
  ) => {
    nodes: FlowNode[];
    edges: Edge[];
  };

  // Add isLoading state
  isLoading: boolean;
}

const INITIAL_STATE = {
  nodes: [],
  edges: [],
  v2Properties: {},
  definition: {
    value: {
      sequence: [],
      properties: {},
    },
    isValid: false,
  },
  selectedNode: null,
  selectedEdge: null,
  errorNode: null,
  openGlobalEditor: true,
  stepEditorOpenForNode: null,
  toolboxConfiguration: { groups: [] },
  isLayouted: false,
  isSaving: false,
  isPendingSync: false,
  lastSyncedAt: 0,
  canDeploy: false,
  changes: 0,
  validationErrors: {
    step: null,
    global: null,
  },
  stepValidationError: null,
  globalValidationError: null,
  validatorConfigurationV2: {
    step: (step: V2Step, parent?: V2Step) => false,
    root: (def: Definition) => false,
  },
  runRequestCount: 0,
  isLoading: true,
};

export const useWorkflowStore = create<WorkflowStore>()(
  devtools((set, get) => ({
    ...INITIAL_STATE,

    // Core Flow Actions
    updateNodes: (nodes) => {
      set({
        nodes,
        isPendingSync: true,
        changes: get().changes + 1,
      });
      get().updateDefinition();
    },

    updateEdges: (edges) => {
      set({
        edges,
        isPendingSync: true,
        changes: get().changes + 1,
      });
      get().updateDefinition();
    },

    updateV2Properties: async (properties) => {
      set({
        v2Properties: { ...get().v2Properties, ...properties },
        isPendingSync: true,
        changes: get().changes + 1,
      });

      // Wait for next tick to ensure state is updated
      await new Promise((resolve) => setTimeout(resolve, 0));
      get().updateDefinition();
    },

    // Internal helper for definition updates
    updateDefinition: debounce(() => {
      const { nodes, edges, v2Properties, validatorConfigurationV2 } = get();
      const newDefinition = getDefinitionFromNodesEdgesProperties(
        nodes,
        edges,
        v2Properties,
        validatorConfigurationV2
      );

      set({
        definition: wrapDefinitionV2(newDefinition),
        isPendingSync: false,
        lastSyncedAt: Date.now(),
      });

      // Validate after definition update
      get().validateWorkflow();
    }, 300),

    // Node/Edge Queries
    getNodeById: (id) =>
      id ? get().nodes.find((node) => node.id === id) : undefined,

    getEdgeById: (id) => get().edges.find((edge) => edge.id === id),

    getNextEdge: (nodeId) => {
      const edge = get().edges.find((e) => e.source === nodeId);
      if (!edge) {
        throw new Error("getNextEdge::Edge not found");
      }
      return edge;
    },

    // Node/Edge Management
    deleteNodes: (ids) => {
      const idArray = Array.isArray(ids) ? ids : [ids];
      set((state) => ({
        nodes: state.nodes.filter((node) => !idArray.includes(node.id)),
        isPendingSync: true,
        changes: state.changes + 1,
      }));
      get().updateDefinition();
    },

    deleteEdges: (ids) => {
      const idArray = Array.isArray(ids) ? ids : [ids];
      set((state) => ({
        edges: state.edges.filter((edge) => !idArray.includes(edge.id)),
        isPendingSync: true,
        changes: state.changes + 1,
      }));
      get().updateDefinition();
    },

    updateNode: (node) => {
      set((state) => ({
        nodes: state.nodes.map((n) => (n.id === node.id ? node : n)),
        isPendingSync: true,
        changes: state.changes + 1,
      }));
      get().updateDefinition();
    },

    updateEdge: (id, key, value) => {
      set((state) => ({
        edges: state.edges.map((e) =>
          e.id === id ? { ...e, [key]: value } : e
        ),
        isPendingSync: true,
        changes: state.changes + 1,
      }));
      get().updateDefinition();
    },

    duplicateNode: (node) => {
      const newId = uuidv4();
      const newNode = {
        ...node,
        id: newId,
        data: { ...node.data, id: newId },
        position: {
          x: node.position.x + 100,
          y: node.position.y + 100,
        },
      };

      set((state) => ({
        nodes: [...state.nodes, newNode],
        isPendingSync: true,
        changes: state.changes + 1,
      }));
      get().updateDefinition();
    },

    // UI Actions
    setSelectedNode: (id) =>
      set({
        selectedNode: id,
        selectedEdge: null,
        openGlobalEditor: false,
      }),

    setSelectedEdge: (id) =>
      set({
        selectedEdge: id,
        selectedNode: null,
        openGlobalEditor: true,
      }),

    setErrorNode: (id) => set({ errorNode: id }),

    setOpenGlobalEditor: (open) => set({ openGlobalEditor: open }),

    setStepEditorOpenForNode: (nodeId) =>
      set({
        stepEditorOpenForNode: nodeId,
        openGlobalEditor: false,
      }),

    setIsLayouted: (isLayouted) => set({ isLayouted }),

    // Validation
    validateStep: (step, parent) => {
      const result = stepValidatorV2(step, parent);
      set((state) => ({
        validationErrors: {
          ...state.validationErrors,
          step: result.error?.message ?? null,
        },
        stepValidationError: result.error?.message ?? null,
      }));
      return result.isValid;
    },

    validateWorkflow: () => {
      const { definition } = get();
      const result = globalValidatorV2(definition.value);
      set((state) => ({
        validationErrors: {
          ...state.validationErrors,
          global: result.error?.message ?? null,
        },
        globalValidationError: result.error?.message ?? null,
        canDeploy: result.isValid,
      }));
      return result.isValid;
    },

    // Workflow Actions
    saveWorkflow: async () => {
      const { definition, isPendingSync, errorNode } = get();
      const workflowId = get().v2Properties.id;

      if (isPendingSync) {
        throw new Error("Cannot save while changes are pending");
      }

      if (errorNode || !definition.isValid) {
        throw new Error("Cannot save invalid workflow");
      }

      set({ isSaving: true });
      try {
        if (workflowId) {
          await updateWorkflow(workflowId, definition.value);
        } else {
          const response = await createWorkflow(definition.value);
          return response?.workflow_id;
        }
      } finally {
        set({ isSaving: false });
      }
    },

    // Complex Node Management
    addNodeBetween: (nodeOrEdge, step, type) => {
      if (!nodeOrEdge || !step) return;

      let edge = {} as Edge;
      if (type === "node") {
        edge = get().edges.find((edge) => edge.target === nodeOrEdge) as Edge;
      }
      if (type === "edge") {
        edge = get().edges.find((edge) => edge.id === nodeOrEdge) as Edge;
      }

      let { source: sourceId, target: targetId } = edge || {};
      if (!sourceId || !targetId) return;

      const isTriggerComponent = step.componentType === "trigger";

      // Validation checks
      if (sourceId !== "trigger_start" && isTriggerComponent) {
        return;
      }
      if (sourceId === "trigger_start" && !isTriggerComponent) {
        return;
      }

      const nodes = get().nodes;
      if (
        sourceId === "trigger_start" &&
        isTriggerComponent &&
        nodes.find((node) => node && step.id === node.id)
      ) {
        return;
      }

      let targetIndex = nodes.findIndex((node) => node.id === targetId);
      const sourceIndex = nodes.findIndex((node) => node.id === sourceId);
      if (targetIndex === -1) return;

      if (sourceId === "trigger_start") {
        targetId = "trigger_end";
      }

      const newNodeId = isTriggerComponent ? step.id : uuidv4();
      const cloneStep = { ...step, id: newNodeId };
      const edges = get().edges;

      // Process new workflow structure
      let { nodes: newNodes, edges: newEdges } = processWorkflowV2(
        [
          {
            id: sourceId,
            type: "temp_node",
            name: "temp_node",
            componentType: "temp_node",
            edgeLabel: edge.label,
            edgeColor: edge?.style?.stroke,
          },
          cloneStep,
          {
            id: targetId,
            type: "temp_node",
            name: "temp_node",
            componentType: "temp_node",
            edgeNotNeeded: true,
          },
        ] as V2Step[],
        { x: 0, y: 0 },
        true
      );

      // Update edges
      const finalEdges = [
        ...newEdges,
        ...(edges.filter(
          (edge) => !(edge.source === sourceId && edge.target === targetId)
        ) || []),
      ];

      // Update nodes
      const isNested = !!(
        nodes[targetIndex]?.isNested || nodes[sourceIndex]?.isNested
      );
      newNodes = newNodes.map((node) => ({ ...node, isNested }));
      newNodes = [
        ...nodes.slice(0, targetIndex),
        ...newNodes,
        ...nodes.slice(targetIndex),
      ];

      // Update store
      set({
        edges: finalEdges,
        nodes: newNodes,
        isLayouted: false,
        changes: get().changes + 1,
        isPendingSync: true,
      });

      // Handle special node types
      if (["interval", "manual", "alert", "incident"].includes(newNodeId)) {
        const specialNodeProps =
          newNodeId === "alert" ? {} : newNodeId === "incident" ? {} : "";

        set((state) => ({
          v2Properties: {
            ...state.v2Properties,
            [newNodeId]: specialNodeProps,
          },
        }));
      }

      // Update selection
      if (type === "edge") {
        set({ selectedEdge: edges[edges.length - 1]?.id });
      } else if (type === "node") {
        set({ selectedNode: nodeOrEdge });
      } else if (newNodeId) {
        set({ selectedNode: newNodeId });
      }

      get().updateDefinition();
    },

    // Update initialize to handle layout
    initialize: (yamlString: string, providers = []) => {
      set({ ...INITIAL_STATE, isLoading: true });

      if (!yamlString) return;

      try {
        const definition = parseWorkflow(yamlString, providers);
        const { nodes, edges } = processWorkflowV2(definition.sequence, {
          x: 0,
          y: 0,
        });

        set({
          nodes,
          edges,
          v2Properties: definition.properties || {},
          definition: wrapDefinitionV2(definition),
          lastSyncedAt: Date.now(),
          isLoading: false,
          toolboxConfiguration: getToolboxConfiguration(providers),
        });

        // Trigger layout after setting initial nodes/edges
        get().onLayout({ direction: "DOWN" });
        get().validateWorkflow();
      } catch (error) {
        console.error("Failed to initialize workflow:", error);
        const errorMessage =
          error instanceof YAMLException
            ? `Invalid YAML: ${error.message}`
            : "Failed to initialize workflow";

        set((state) => ({
          validationErrors: {
            ...state.validationErrors,
            global: errorMessage,
          },
          isLoading: false,
        }));
      }
    },

    cleanup: () => {
      set(INITIAL_STATE);
    },

    // Add new method for empty workflow creation
    // TODO: fix
    initializeEmpty: (options = {}) => {
      set(INITIAL_STATE);

      try {
        const workflowId = options.workflowId || uuidv4();
        let triggers = {};

        if (options.alertName && options.alertSource) {
          triggers = {
            alert: {
              source: options.alertSource,
              name: options.alertName,
            },
          };
        }

        const definition = wrapDefinitionV2({
          ...generateWorkflow(
            workflowId,
            "", // name
            "", // description
            false, // disabled
            {}, // consts
            [], // steps
            [], // conditions
            triggers
          ),
          isValid: true,
        });

        const { nodes, edges } = processWorkflowV2(definition.value.sequence, {
          x: 0,
          y: 0,
        });

        set({
          nodes,
          edges,
          v2Properties: definition.value.properties || {},
          definition,
          isLayouted: true,
          lastSyncedAt: Date.now(),
        });

        get().validateWorkflow();
      } catch (error) {
        console.error("Failed to initialize empty workflow:", error);
        set((state) => ({
          validationErrors: {
            ...state.validationErrors,
            global: "Failed to initialize empty workflow",
          },
        }));
      }
    },

    // Node Data Updates
    updateSelectedNodeData: (key, value) => {
      const currentSelectedNode = get().selectedNode;
      if (currentSelectedNode) {
        const updatedNodes = get().nodes.map((node) => {
          if (node.id === currentSelectedNode) {
            // Properties changes should not reconstruct the definition
            // Only reconstruct if there are structural changes to the flow
            if (value) {
              node.data[key] = value;
            } else {
              delete node.data[key];
            }
            return { ...node };
          }
          return node;
        });

        set({
          nodes: updatedNodes,
          changes: get().changes + 1,
        });
      }
    },

    // Flow Operations
    setNodes: (nodes) => {
      set({ nodes });
    },

    setEdges: (edges) => {
      set({ edges });
    },

    onNodesChange: (changes) => {
      set((state) => ({
        nodes: applyNodeChanges(changes, state.nodes),
        isPendingSync: true,
        changes: state.changes + 1,
      }));
      get().updateDefinition();
    },

    onEdgesChange: (changes) => {
      set((state) => ({
        edges: applyEdgeChanges(changes, state.edges),
        isPendingSync: true,
        changes: state.changes + 1,
      }));
      get().updateDefinition();
    },

    onConnect: (connection) => {
      set((state) => ({
        edges: addEdge(connection, state.edges),
        isPendingSync: true,
        changes: state.changes + 1,
      }));
      get().updateDefinition();
    },

    onDragOver: (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    onDrop: (event, getPosition) => {
      event.preventDefault();
      event.stopPropagation();

      try {
        let step: any = event.dataTransfer.getData("application/reactflow");
        if (!step) {
          return;
        }
        step = JSON.parse(step);
        if (!step) return;

        // Use the getPosition function to get flow coordinates
        const position = getPosition();

        const newUuid = uuidv4();
        const newNode = {
          id: newUuid,
          type: "custom",
          position,
          data: {
            label: step.name! as string,
            ...step,
            id: newUuid,
            name: step.name,
            type: step.type,
            componentType: step.componentType,
          },
          isDraggable: true,
          dragHandle: ".custom-drag-handle",
        } as FlowNode;

        set({ nodes: [...get().nodes, newNode] });
      } catch (err) {
        console.error(err);
      }
    },

    setToolBoxConfig: (config) => {
      set({ toolboxConfiguration: config });
    },

    // Test Run Actions
    triggerTestRun: () => {
      set((state) => ({
        runRequestCount: state.runRequestCount + 1,
      }));
    },

    // Layout Operations
    getLayoutedElements: (nodes, edges, options = {}) => {
      const isHorizontal = options?.["elk.direction"] === "RIGHT";
      const dagreGraph = new graphlib.Graph();
      dagreGraph.setDefaultEdgeLabel(() => ({}));

      dagreGraph.setGraph({
        rankdir: isHorizontal ? "LR" : "TB",
        nodesep: 80,
        ranksep: 80,
        edgesep: 80,
      });

      nodes.forEach((node) => {
        const type = node?.data?.type
          ?.replace("step-", "")
          ?.replace("action-", "")
          ?.replace("condition-", "")
          ?.replace("__end", "");

        let width = ["start", "end"].includes(type) ? 80 : 280;
        let height = 80;

        if (node.id === "trigger_start" || node.id === "trigger_end") {
          width = 150;
          height = 40;
        }

        dagreGraph.setNode(node.id, { width, height });
      });

      edges.forEach((edge) => {
        dagreGraph.setEdge(edge.source, edge.target);
      });

      dagre.layout(dagreGraph);

      const layoutedNodes = nodes.map((node) => {
        const dagreNode = dagreGraph.node(node.id);
        return {
          ...node,
          targetPosition: isHorizontal ? "left" : "top",
          sourcePosition: isHorizontal ? "right" : "bottom",
          style: {
            ...node.style,
            width: dagreNode.width as number,
            height: dagreNode.height as number,
          },
          position: {
            x: dagreNode.x - dagreNode.width / 2,
            y: dagreNode.y - dagreNode.height / 2,
          },
        };
      });

      return {
        nodes: layoutedNodes,
        edges,
      };
    },

    onLayout: ({
      direction,
      useInitialNodes = false,
      initialNodes,
      initialEdges,
    }) => {
      const opts = { "elk.direction": direction };
      const ns = useInitialNodes ? initialNodes : get().nodes;
      const es = useInitialNodes ? initialEdges : get().edges;

      const { nodes: layoutedNodes, edges: layoutedEdges } =
        get().getLayoutedElements(ns, es, opts);

      const finalEdges = layoutedEdges.map((edge: Edge) => ({
        ...edge,
        animated: !!edge?.target?.includes("empty"),
        data: { ...edge.data, isLayouted: true },
      }));

      const finalNodes = layoutedNodes.map((node: FlowNode) => ({
        ...node,
        data: { ...node.data, isLayouted: true },
      }));

      set({
        nodes: finalNodes,
        edges: finalEdges,
        isLayouted: true,
      });
    },
  }))
);
