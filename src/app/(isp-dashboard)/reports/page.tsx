import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/shared/placeholder-page";

export const metadata: Metadata = { title: "Reports" };

export default function ReportsPage() {
  return <PlaceholderPage href="/reports" />;
}
