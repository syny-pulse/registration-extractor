import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet";
};

export function Button({ variant = "primary", className, ...props }: ButtonProps) {
  const base =
    "inline-flex items-center justify-center h-10 px-4 text-sm font-medium " +
    "transition-colors disabled:opacity-40 disabled:cursor-not-allowed select-none";

  const variants = {
    primary: "bg-ink text-paper hover:bg-neutral-800",
    secondary: "border border-rule-strong text-ink hover:bg-wash",
    quiet: "text-muted hover:text-ink underline underline-offset-4",
  } as const;

  return <button className={cx(base, variants[variant], className)} {...props} />;
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        "h-10 w-full border border-rule-strong bg-paper px-3 text-sm",
        "placeholder:text-muted focus:border-ink",
        className,
      )}
      {...props}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium tracking-wide uppercase text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

/**
 * Errors get a heavy left rule rather than a red background, per the palette.
 * Weight reads as urgency here without spending a colour on it.
 */
export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "error";
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cx(
        "px-3 py-2 text-sm",
        tone === "error"
          ? "border-l-2 border-ink bg-wash font-medium"
          : "border-l-2 border-rule-strong bg-wash text-muted",
      )}
    >
      {children}
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("border border-rule bg-paper", className)}>{children}</div>;
}

export function Th({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th
      className={cx(
        "border-b border-rule-strong px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <td className={cx("border-b border-rule px-3 py-2 text-sm align-middle", className)}>
      {children}
    </td>
  );
}
