import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/shared/placeholder-page";

export const metadata: Metadata = { title: "Payments" };

export default function PaymentsPage() {
  return <PlaceholderPage href="/payments" />;
}
