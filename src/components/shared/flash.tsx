import { Alert, AlertDescription } from "@/components/ui/alert";

/** Shows a one-line result passed back in the URL after a redirect. */
export function Flash({ error, success }: { error?: string | null; success?: string | null }) {
  if (!error && !success) return null;
  return (
    <Alert variant={error ? "danger" : "success"} className="mb-4" aria-live="polite">
      <AlertDescription className="text-foreground">{error ?? success}</AlertDescription>
    </Alert>
  );
}
