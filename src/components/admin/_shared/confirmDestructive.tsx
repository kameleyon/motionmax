import { useEffect, useId, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Props for the typed-confirm AlertDialog used by every destructive admin
 * action (delete user, engage kill switch, mass-revoke API keys, etc.).
 *
 * The pattern is intentionally typo-proof: the user has to type the exact
 * `confirmText` (commonly the target email or the literal word `DELETE`)
 * before the action button enables. See `AdminUserDetails.tsx` for the
 * original inline implementation this component generalizes.
 */
export interface ConfirmDestructiveProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  /** User must type this string to enable the confirm button. Case-sensitive. */
  confirmText: string;
  /** Label for the confirm button — e.g. 'Delete user', 'Engage kill switch'. */
  actionLabel: string;
  /**
   * Async handler. Receives nothing (the caller already knows the target).
   * Should reject (throw) on failure so the dialog stays open and surfaces
   * `error.message` in a toast.
   */
  onConfirm: () => Promise<void>;
  /**
   * Optional success toast message. If supplied, the dialog auto-closes on
   * resolved and shows this string via `toast.success`.
   */
  successMessage?: string;
}

export function ConfirmDestructive({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  actionLabel,
  onConfirm,
  successMessage,
}: ConfirmDestructiveProps): JSX.Element {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const inputId = useId();

  // Reset the typed value whenever the dialog reopens — otherwise the next
  // time it opens for a different target it would still hold the previous
  // confirm string.
  useEffect(() => {
    if (open) {
      setValue("");
      setPending(false);
    }
  }, [open]);

  const matches = value === confirmText;

  async function handleConfirm(e: React.MouseEvent<HTMLButtonElement>) {
    // Radix's AlertDialogAction default-closes on click; we need to keep the
    // dialog open while the async work runs (and on error).
    e.preventDefault();
    if (!matches || pending) return;
    setPending(true);
    try {
      await onConfirm();
      if (successMessage) toast.success(successMessage);
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Action failed";
      toast.error(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Don't allow dismiss-while-pending; the action is in flight.
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <div className="text-sm text-muted-foreground">{description}</div>
              <div className="space-y-1.5">
                <Label htmlFor={inputId} className="text-xs text-muted-foreground">
                  Type{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
                    {confirmText}
                  </code>{" "}
                  to confirm
                </Label>
                <Input
                  id={inputId}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={confirmText}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  disabled={pending}
                />
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={!matches || pending}
            className={cn(buttonVariants({ variant: "destructive" }))}
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
