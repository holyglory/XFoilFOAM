import { notFound } from "next/navigation";
import { CatalogContent } from "@/components/browse/CatalogContent";

// Generate the anonymous first page from the running API. A production build
// can complete before the API starts. Later refreshes keep the last good page.
export const dynamic = "force-static";
export const revalidate = 5;
export function generateStaticParams() {
  return [];
}

export default async function DefaultCatalogPage({
  params,
}: {
  params: Promise<{ view: string }>;
}) {
  if ((await params).view !== "default") notFound();
  return <CatalogContent conditionKey="" />;
}
