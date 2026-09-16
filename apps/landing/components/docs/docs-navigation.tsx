"use client";

import { Dialog } from "@base-ui/react/dialog";
import { BookOpen, Bot, ChevronDown, ChevronRight, Code2, Compass, LifeBuoy, Menu, Plug, Rocket, Server, SlidersHorizontal, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DocsLink } from "./docs-link";

type NavigationGroup = { title: string; pages: { title: string; href: string }[] };
const groupIcons: Record<string, typeof BookOpen> = {
  Overview: Compass,
  "Getting started": Rocket,
  "Working with bots": Bot,
  "Connect your tools": Plug,
  Configuration: SlidersHorizontal,
  "Self-hosting": Server,
  Help: LifeBuoy,
  "Advanced setup": Code2,
};

function revealCurrent(rail: HTMLElement | null) {
  const currentLink = rail?.querySelector<HTMLElement>('[aria-current="page"]');
  if (!rail?.clientHeight || !currentLink) return;
  const item = currentLink.getBoundingClientRect();
  const bounds = rail.getBoundingClientRect();
  if (item.top < bounds.top + 16 || item.bottom > bounds.bottom - 16) {
    rail.scrollBy({ top: item.top - bounds.top - rail.clientHeight / 2, behavior: "instant" });
  }
}

function NavigationList({ groups, pathname, label, idPrefix, onNavigate }: {
  groups: NavigationGroup[];
  pathname: string;
  label: string;
  idPrefix: string;
  onNavigate?: () => void;
}) {
  const activeGroup = groups.find((group) => group.pages.some((page) => page.href === pathname))?.title;
  const [sections, setSections] = useState(() => ({
    activeGroup,
    expanded: new Set(["Overview", "Getting started", activeGroup]),
  }));
  if (sections.activeGroup !== activeGroup) {
    setSections({ activeGroup, expanded: new Set([...sections.expanded, activeGroup]) });
  }

  return (
    <nav aria-label={label}>
      {groups.map((group, index) => {
        const Icon = groupIcons[group.title] ?? BookOpen;
        const open = sections.expanded.has(group.title);
        return (
          <div className="docs-nav-group" data-active={activeGroup === group.title || undefined} key={group.title}>
            <button
              className="docs-group-trigger"
              type="button"
              aria-expanded={open}
              aria-controls={`${idPrefix}-${index}`}
              onClick={() => setSections((current) => {
                const next = new Set(current.expanded);
                if (next.has(group.title)) next.delete(group.title);
                else next.add(group.title);
                return { ...current, expanded: next };
              })}
            >
              <Icon size={17} aria-hidden="true" />
              <span>{group.title}</span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            <div className="docs-nav-pages" data-open={open || undefined} id={`${idPrefix}-${index}`} inert={!open} aria-hidden={!open}>
              <div>
                <ul>
                  {group.pages.map((page) => (
                    <li key={page.href}>
                      <DocsLink href={page.href} aria-current={pathname === page.href ? "page" : undefined} onNavigate={onNavigate}>
                        {page.title}
                      </DocsLink>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        );
      })}
    </nav>
  );
}

export function DocsNavigation({ groups }: { groups: NavigationGroup[] }) {
  const pathname = usePathname().replace(/\/$/, "") || "/docs";
  const [open, setOpen] = useState(false);
  const [previousPath, setPreviousPath] = useState(pathname);
  const sidebar = useRef<HTMLElement>(null);
  const drawer = useRef<HTMLDivElement>(null);
  const focusArticle = useRef(false);
  const current = groups.flatMap((group) => group.pages).find((page) => page.href === pathname);

  if (previousPath !== pathname) {
    setPreviousPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (focusArticle.current) document.getElementById("docs-content")?.focus({ preventScroll: true });
  }, [pathname]);

  useEffect(() => {
    // Reveal after the active section expands, without interrupting manual rail scrolling.
    const timer = window.setTimeout(() => revealCurrent(sidebar.current), 240);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 960px)");
    const closeOnDesktop = () => { if (desktop.matches) setOpen(false); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  return (
    <>
      <aside className="docs-sidebar" id="docs-sidebar" ref={sidebar}>
        <NavigationList groups={groups} pathname={pathname} label="Documentation" idPrefix="docs-sidebar-group" />
      </aside>
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (next) focusArticle.current = false;
          setOpen(next);
        }}
        onOpenChangeComplete={(isOpen) => {
          if (isOpen) revealCurrent(drawer.current);
          else if (focusArticle.current) document.getElementById("docs-content")?.focus({ preventScroll: true });
        }}
      >
        <div className="docs-mobile-bar">
          <Dialog.Trigger className="docs-menu-trigger" id="docs-menu-trigger">
            <Menu size={18} aria-hidden="true" />
            <span>Browse docs</span>
            <ChevronRight size={14} aria-hidden="true" />
            <span className="docs-mobile-current">{current?.title ?? "Documentation"}</span>
          </Dialog.Trigger>
        </div>
        <Dialog.Portal>
          <Dialog.Backdrop className="docs-drawer-backdrop" />
          <Dialog.Popup
            className="docs-drawer"
            id="docs-menu"
            finalFocus={() => focusArticle.current ? document.getElementById("docs-content") : true}
          >
            <div className="docs-drawer-header">
              <Dialog.Title id="docs-menu-title"><BookOpen size={20} aria-hidden="true" /> Documentation</Dialog.Title>
              <Dialog.Close className="docs-drawer-close" aria-label="Close documentation menu"><X size={20} /></Dialog.Close>
            </div>
            <div className="docs-drawer-scroll" ref={drawer}>
              <NavigationList
                groups={groups}
                pathname={pathname}
                label="Mobile documentation"
                idPrefix="docs-drawer-group"
                onNavigate={() => {
                  focusArticle.current = true;
                  setOpen(false);
                }}
              />
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
