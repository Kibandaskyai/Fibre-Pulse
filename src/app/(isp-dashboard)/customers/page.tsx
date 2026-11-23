import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/shared/placeholder-page";

export const metadata: Metadata = { title: "Customers" };

export default function CustomersPage() {
  return <PlaceholderPage href="/customers" />;
}
