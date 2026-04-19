import React from "react";
import { render as rtlRender, type RenderOptions } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "next-themes";

export function makeTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

interface TestProviderProps {
  children: React.ReactNode;
  queryClient?: QueryClient;
  initialEntries?: string[];
}

export function TestProviders({ children, queryClient, initialEntries = ["/"] }: TestProviderProps) {
  const client = queryClient ?? makeTestQueryClient();
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider attribute="class" defaultTheme="light" disableTransitionOnChange>
        <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

interface CustomRenderOptions extends Omit<RenderOptions, "wrapper"> {
  queryClient?: QueryClient;
  initialEntries?: string[];
}

function render(ui: React.ReactElement, options?: CustomRenderOptions) {
  const { queryClient, initialEntries, ...rest } = options ?? {};
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <TestProviders queryClient={queryClient} initialEntries={initialEntries}>
        {children}
      </TestProviders>
    ),
    ...rest,
  });
}

export * from "@testing-library/react";
export { render };
export { server } from "./server";
export { handlers } from "./handlers";
