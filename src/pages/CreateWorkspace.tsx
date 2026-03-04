import { useRef } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { WorkspaceRouter } from "@/components/workspace/WorkspaceRouter";
import type { WorkspaceHandle } from "@/components/workspace/Doc2VideoWorkspace";

const CreateWorkspace = () => {
  const workspaceRef = useRef<WorkspaceHandle>(null);

  return (
    <SidebarProvider defaultOpen={true}>
      <div className="flex min-h-screen w-full overflow-hidden">
        <AppSidebar />
        <main className="flex-1 min-w-0 overflow-hidden">
          <WorkspaceRouter ref={workspaceRef} />
        </main>
      </div>
    </SidebarProvider>
  );
};

export default CreateWorkspace;