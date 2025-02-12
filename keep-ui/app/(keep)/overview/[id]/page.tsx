"use client";

import { useEffect, useState } from "react";
import { SupersetDashboard } from "../SupersetDashboard";
import { useSupersetDashboards } from "@/utils/hooks/useSupersetDashboards";
import { Loader2 } from "lucide-react";

type Props = {
  params: {
    id: string;
  };
};

export default function DashboardPage({ params: { id } }: Props) {
  const { dashboards, isLoading, error } = useSupersetDashboards();
  const [dashboardId, setDashboardId] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && dashboards.length > 0) {
      // Find the dashboard with matching numeric ID
      const dashboard = dashboards.find((d) => d.id === id);
      if (dashboard) {
        setDashboardId(dashboard.id);
      }
    }
  }, [dashboards, id, isLoading]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
          <span className="text-gray-600">Loading dashboard...</span>
        </div>
      </div>
    );
  }

  if (error || !dashboardId) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-lg text-red-500">
          Error: {error ? error.message : "Dashboard not found"}
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full">
      <SupersetDashboard dashboardId={dashboardId} />
    </div>
  );
}
