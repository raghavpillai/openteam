"use client";

import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";

const SidebarContext = createContext({ expanded: true, toggle: () => {} });

export function DocsShell({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <SidebarContext.Provider value={{ expanded, toggle: () => setExpanded((current) => !current) }}>
      <div className="ot-docs" id="top" data-sidebar-collapsed={!expanded || undefined}>
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

export function useDocsSidebar() {
  return useContext(SidebarContext);
}

export function DocsSidebarToggle() {
  const { expanded, toggle } = useDocsSidebar();
  const label = expanded ? "Hide sidebar" : "Show sidebar";
  const Icon = expanded ? PanelLeftClose : PanelLeftOpen;

  return (
    <button
      className="docs-sidebar-toggle"
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      aria-controls="docs-sidebar"
    >
      <Icon size={19} aria-hidden="true" />
    </button>
  );
}
