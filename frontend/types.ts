export type Action = { type: 'click'; target: string } | { type: 'fill'; target: string; value: string } | { type: 'release'; request: string } | { type: 'wait'; target: string; value: string };
export interface Challenge {
  id: string; title: string; subtitle: string; category: string; difficulty: string; goal: string; hint: string; explanation: string; accent: string; targetMoves: number;
  initialActions: Action[]; actions: Action[]; completion: { target: string; value: string }; assertion: { target: string; operator: string; expected: string | number }; schedule: { id: string; key: string; response: unknown; status: number }[];
}
export interface Health { status: string; liveEnabled: boolean; liveDisabledReasons: string[]; modelProvider?: string; modelConfigured?: boolean }
export interface Job { id: string; state: string; mode: 'live' | 'recorded'; events: { state: string; at: string; message: string }[]; error: string | { message: string } | null; result: Record<string, unknown> | null; challengeId?: string }
export const terminalStates = new Set(['completed', 'failed', 'not-reproduced', 'cancelled']);
export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try { const body = await response.json(); message = typeof body.detail === 'string' ? body.detail : typeof body.detail?.message === 'string' ? body.detail.message : typeof body.error === 'string' ? body.error : message; } catch { /* Plain HTTP errors stay readable. */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
export function actionLabel(action: Action): string {
  if (action.type === 'release') return `Release ${action.request}`;
  if (action.type === 'fill') return `Enter “${action.value}” in ${action.target.replaceAll('-', ' ')}`;
  if (action.type === 'wait') return `Observe ${action.target.replaceAll('-', ' ')}: ${action.value}`;
  return `Click ${action.target.replaceAll('-', ' ')}`;
}
