import { useRef } from "react";
import { WorkspaceRouter } from "@/components/workspace/WorkspaceRouter";
import type { WorkspaceHandle } from "@/components/workspace/types";

// SidebarProvider + AppSidebar are now provided by AppShell in App.tsx
const CreateWorkspace = () => {
  const workspaceRef = useRef<WorkspaceHandle>(null);
  return <WorkspaceRouter ref={workspaceRef} />;
};

export default CreateWorkspace;
