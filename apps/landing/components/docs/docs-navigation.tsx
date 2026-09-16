"use client";

import { BookOpen, Bot, ChevronDown, Code2, LifeBuoy, Menu, Plug, Server, SlidersHorizontal } from "lucide-react";
import { DocsLink } from "./docs-link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

type NavigationGroup = { title: string; pages: { title: string; href: string }[] };
const groupIcons: Record<string, typeof BookOpen> = {
  "Getting started": BookOpen,
  "Working with bots": Bot,
  "Connect your tools": Plug,
  Configuration: SlidersHorizontal,
  "Self-hosting": Server,
  Help: LifeBuoy,
  "Advanced setup": Code2,
};

export function DocsNavigation({ groups }: { groups: NavigationGroup[] }) {
  const pathname = usePathname().replace(/\/$/, "") || "/docs";
  const menu = useRef<HTMLDetailsElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const focusArticle = useRef(false);
  const previousPathname = useRef(pathname);
  useEffect(() => {
    if (previousPathname.current !== pathname && menu.current) menu.current.open = false;
    previousPathname.current = pathname;
    if (focusArticle.current) {
      document.getElementById("docs-content")?.focus({ preventScroll: true });
      focusArticle.current = false;
    }
    const current = sidebar.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (current && sidebar.current) {
      const item = current.getBoundingClientRect();
      const rail = sidebar.current.getBoundingClientRect();
      if (item.top < rail.top + 20 || item.bottom > rail.bottom - 20) {
        sidebar.current.scrollTo({ top: current.offsetTop - sidebar.current.clientHeight / 2 });
      }
    }
  }, [pathname]);
  useEffect(() => {
    const dismiss = (event: PointerEvent | FocusEvent) => {
      if (menu.current?.open && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, []);

  const navigation = (label: string) => (
    <nav aria-label={label}>
      {groups.map((group) => {
        const Icon = groupIcons[group.title] ?? BookOpen;
        return (
        <div className="docs-nav-group" key={group.title}>
          <p><Icon size={15} aria-hidden="true" />{group.title}</p>
          <ul>
            {group.pages.map((page) => (
              <li key={page.href}>
                <DocsLink
                  href={page.href}
                  aria-current={pathname === page.href ? "page" : undefined}
                  onNavigate={() => {
                    if (!menu.current?.open) return;
                    menu.current.open = false;
                    if (pathname === page.href) document.getElementById("docs-content")?.focus({ preventScroll: true });
                    else focusArticle.current = true;
                  }}
                >
                  {page.title}
                </DocsLink>
              </li>
            ))}
          </ul>
        </div>
        );
      })}
    </nav>
  );

  const current = groups.flatMap((group) => group.pages).find((page) => page.href === pathname);
  return (
    <>
      <aside className="docs-sidebar" ref={sidebar}>{navigation("Documentation")}</aside>
      <details
        className="docs-mobile-nav"
        ref={menu}
        // Native details can be opened before React hydrates; preserve that state.
        suppressHydrationWarning
        onToggle={() => {
          if (!menu.current?.open) return;
          const nav = menu.current.querySelector("nav");
          const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
          if (nav && current) {
            const item = current.getBoundingClientRect();
            const panel = nav.getBoundingClientRect();
            if (item.top < panel.top || item.bottom > panel.bottom) {
              nav.scrollTop += item.top - panel.top - nav.clientHeight / 2;
            }
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && menu.current) {
            menu.current.open = false;
            menu.current.querySelector("summary")?.focus();
          }
        }}
      >
        <summary>
          <Menu size={17} aria-hidden="true" />
          <span className="docs-menu-label">Menu</span>
          <span className="docs-mobile-current">{current?.title ?? "Documentation"}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        {navigation("Mobile documentation")}
      </details>
    </>
  );
}
