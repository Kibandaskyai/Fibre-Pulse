import { KENYA_TZ } from "@/lib/format";

/** "14:15" in Kenyan time, for hourly or 15-minute chart buckets. */
export const hourLabel = (iso: string) => new Date(iso).toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: KENYA_TZ });
