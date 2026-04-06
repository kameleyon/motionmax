import { WorkspaceRouter } from "@/components/workspace/WorkspaceRouter";

// SidebarProvider + AppSidebar are now provided by AppShell in App.tsx
const CreateWorkspace = () => {
  return <WorkspaceRouter />;
};

export default CreateWorkspace;
