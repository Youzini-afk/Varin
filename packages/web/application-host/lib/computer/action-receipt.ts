import type { ComputerActionReceipt, ComputerActionResult } from '@varin/protocol';
import type { DriverResponse } from './driver-host.js';

/** A backend can report stronger evidence; the Host never infers app success from dispatch. */
export function actionResult(response: DriverResponse): ComputerActionResult {
  const supplied = response.receipt;
  const receipt: ComputerActionReceipt = supplied ?? {
    effect: response.rejected ? 'none' : response.ok ? 'dispatched' : response.cancelled ? 'partial' : 'unknown',
    ...(!response.ok ? { reason: {
      code: response.cancelled ? 'cancelled' as const : 'driver-error' as const,
      message: response.error?.split(/\r?\n/u)[0] || (response.cancelled ? 'The operation was cancelled' : 'The driver did not confirm the operation'),
    }, recovery: 'observe' as const } : {}),
  };
  return {
    accepted: response.ok,
    receipt,
    ...(response.cancelled ? { cancelled: true } : {}),
    ...(receipt.effect === 'unknown' ? { outcome: 'unknown' as const } : receipt.effect === 'partial' ? { outcome: 'partial' as const } : {}),
    ...(receipt.reason?.message ? { detail: receipt.reason.message } : response.text ? { detail: response.text } : {}),
  };
}

export function interruptedAction(message: string, submitted: boolean, cancelled = false): ComputerActionResult {
  return {
    accepted: false, ...(cancelled ? { cancelled: true } : {}), ...(submitted ? { outcome: 'unknown' as const } : {}),
    detail: message,
    receipt: { effect: submitted ? 'unknown' : 'none',
      reason: { code: cancelled ? 'cancelled' : 'connection-lost', message },
      recovery: submitted ? 'observe' : 'reconnect' },
  };
}
