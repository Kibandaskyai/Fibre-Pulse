/** Turns a Postgres/PostgREST error into a message safe to show a user. */
export function friendlyDbError(error: { code?: string; message?: string } | null | undefined, fallback = "Something went wrong. Please try again."): string {
  if (!error) return fallback;
  switch (error.code) {
    case "23505":
      return "That already exists. Check for a duplicate.";
    case "42501":
      // Our guard functions raise readable messages with this code.
      return error.message && !error.message.includes("row-level security") ? error.message : "You do not have permission to do that.";
    case "23514":
      return error.message?.startsWith("new row") ? "Some values are not allowed. Check the form." : (error.message ?? fallback);
    case "23503":
      return "This record is linked to something that does not exist or cannot be changed.";
    case "PGRST116":
      return "Not found.";
    default:
      return fallback;
  }
}
