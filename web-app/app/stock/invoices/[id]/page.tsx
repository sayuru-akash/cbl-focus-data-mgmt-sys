import { IntakeDetail } from "../../../../src/features/Details";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <IntakeDetail id={id} />;
}
