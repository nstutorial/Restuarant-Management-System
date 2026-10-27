export type ApiHealth = { status: string; service: string };

export async function getApiHealth(): Promise<ApiHealth> {
  const response = await fetch('/api/health');
  if (!response.ok) throw new Error('API health request failed');
  return response.json() as Promise<ApiHealth>;
}
