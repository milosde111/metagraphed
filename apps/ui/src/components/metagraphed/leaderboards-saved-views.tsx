import { useNavigate, useSearch } from "@tanstack/react-router";
import { Scale, UserMinus, type LucideIcon } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

type Patch = {
  window?: "7d" | "30d";
  weightsSort?: string;
  weightsOrder?: "asc" | "desc";
  deregSort?: string;
  deregOrder?: "asc" | "desc";
};

type Preset = {
  id: string;
  label: string;
  icon: LucideIcon;
  patch: Patch;
  hint?: string;
};

const PRESETS: Preset[] = [
  {
    id: "weights-7d",
    label: "Weight-sets · 7d",
    icon: Scale,
    patch: {
      window: "7d",
      weightsSort: "weight_sets",
      weightsOrder: "desc",
    },
    hint: "highest weight-setting activity this week",
  },
  {
    id: "weights-30d",
    label: "Weight-sets · 30d",
    icon: Scale,
    patch: {
      window: "30d",
      weightsSort: "weight_sets",
      weightsOrder: "desc",
    },
    hint: "highest weight-setting activity this month",
  },
  {
    id: "dereg-7d",
    label: "Deregistrations · 7d",
    icon: UserMinus,
    patch: {
      window: "7d",
      deregSort: "deregistrations",
      deregOrder: "desc",
    },
    hint: "most evictions this week",
  },
  {
    id: "dereg-30d",
    label: "Deregistrations · 30d",
    icon: UserMinus,
    patch: {
      window: "30d",
      deregSort: "deregistrations",
      deregOrder: "desc",
    },
    hint: "most evictions this month",
  },
];

function matches(search: Record<string, unknown>, patch: Patch) {
  return Object.entries(patch).every(([k, v]) => String(search[k] ?? "") === String(v));
}

/** Preset window/sort chips for /leaderboards — mirrors SubnetsSavedViews (#5344). */
export function LeaderboardsSavedViews() {
  const search = useSearch({ from: "/leaderboards" }) as Record<string, unknown>;
  const navigate = useNavigate({ from: "/leaderboards" });

  return (
    <div className="-mt-2 mb-6">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Saved views
        </span>
        <span aria-hidden className="h-px flex-1 bg-border/60" />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => {
          const active = matches(search, p.patch);
          const Icon = p.icon;
          return (
            <button
              key={p.id}
              type="button"
              title={p.hint}
              onClick={() =>
                navigate({
                  search: (prev: Record<string, unknown>) =>
                    ({ ...prev, ...p.patch }) as never,
                  replace: true,
                })
              }
              className={classNames(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 font-mono text-[10px] uppercase tracking-widest transition-colors",
                active
                  ? "border-accent bg-primary-soft text-ink-strong"
                  : "border-border bg-card text-ink-muted hover:border-accent/50 hover:text-ink-strong",
              )}
              aria-pressed={active}
            >
              <Icon className="size-3" aria-hidden />
              {p.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
