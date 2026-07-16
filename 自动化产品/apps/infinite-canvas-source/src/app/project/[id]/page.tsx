import { ProjectClient } from "@/components/workspace/ProjectClient";

export async function generateStaticParams(): Promise<{ id: string }[]> {
  return [{ id: "__static-export-placeholder__" }];
}

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProjectClient projectId={id} />;
}
