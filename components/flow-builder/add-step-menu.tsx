"use client";

import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  paletteCategories,
  type PaletteItem,
} from "./node-palette";

export function AddStepMenu({
  open,
  title = "Add next step",
  onClose,
  onSelect,
}: {
  open: boolean;
  title?: string;
  onClose: () => void;
  onSelect: (item: PaletteItem) => void;
}) {
  const [query, setQuery] = useState("");

  const items = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return paletteCategories.flatMap((category) =>
      category.items
        .filter(
          (item) =>
            !normalized ||
            `${item.label} ${item.description}`
              .toLowerCase()
              .includes(normalized)
        )
        .map((item) => ({ ...item, category: category.name }))
    );
  }, [query]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center bg-background/45 pt-24 backdrop-blur-[1px]">
      <div className="w-[420px] overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Pick the block you want to add.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search message, condition, tag..."
              className="w-full rounded-xl border border-border bg-background py-2.5 pl-9 pr-3 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        <div className="max-h-[440px] overflow-y-auto px-3 pb-3">
          {items.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No blocks found.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.nodeType}
                    type="button"
                    onClick={() => {
                      onSelect(item);
                      setQuery("");
                    }}
                    className="rounded-xl border border-border bg-background p-3 text-left transition hover:border-primary/40 hover:bg-accent"
                  >
                    <div className="flex items-center gap-2">
                      <span className="rounded-md bg-muted p-1.5 text-muted-foreground">
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-foreground">
                          {item.label}
                        </p>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          {item.category}
                        </p>
                      </div>
                    </div>
                    <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                      {item.description}
                    </p>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
