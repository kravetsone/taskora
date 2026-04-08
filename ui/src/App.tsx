import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { useEffect, useState } from "react";
import { SearchBar } from "@/components/SearchBar";
import { Sidebar } from "@/components/Sidebar";
import { useKeyboard } from "@/hooks/useKeyboard";
import { useSSE } from "@/hooks/useSSE";
import { api, type BoardConfig } from "@/lib/api";

import { Overview } from "@/pages/Overview";
import { TaskList } from "@/pages/TaskList";
import { TaskDetail } from "@/pages/TaskDetail";
import { JobDetailPage } from "@/pages/JobDetail";
import { Schedules } from "@/pages/Schedules";
import { WorkflowList } from "@/pages/WorkflowList";
import { WorkflowDetailPage } from "@/pages/WorkflowDetail";
import { DLQ } from "@/pages/DLQ";
import { Migrations } from "@/pages/Migrations";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2000,
      retry: 1,
    },
  },
});

function Layout() {
  const [config, setConfig] = useState<BoardConfig | null>(null);

  useEffect(() => {
    api
      .getConfig()
      .then(setConfig)
      .catch(() => {
        setConfig({
          title: "taskora board",
          logo: null,
          favicon: null,
          theme: "auto",
          readOnly: false,
          refreshInterval: 2000,
        });
      });
  }, []);

  useSSE();
  useKeyboard();

  // Apply theme
  useEffect(() => {
    if (!config) return;
    const root = document.documentElement;
    if (config.theme === "light") {
      root.classList.add("light");
    } else if (config.theme === "dark") {
      root.classList.remove("light");
    } else {
      // auto: follow system
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      const update = () => {
        if (mq.matches) root.classList.add("light");
        else root.classList.remove("light");
      };
      update();
      mq.addEventListener("change", update);
      return () => mq.removeEventListener("change", update);
    }
  }, [config?.theme]);

  const title = config?.title ?? "taskora board";

  return (
    <div className="flex min-h-screen bg-board-bg">
      <Sidebar title={title} />
      <main className="flex-1 min-w-0 overflow-auto">
        <div className="flex justify-end p-3 border-b border-board-border">
          <SearchBar />
        </div>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/tasks" element={<TaskList />} />
          <Route path="/tasks/:taskName" element={<TaskDetail />} />
          <Route path="/tasks/:taskName/migrations" element={<Migrations />} />
          <Route path="/jobs/:jobId" element={<JobDetailPage />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route path="/workflows" element={<WorkflowList />} />
          <Route path="/workflows/:workflowId" element={<WorkflowDetailPage />} />
          <Route path="/dlq" element={<DLQ />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/board">
        <Layout />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
