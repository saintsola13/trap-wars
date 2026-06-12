// HTTP-polling transaction confirmation.
//
// web3.js connection.confirmTransaction() relies on a WebSocket
// (signatureSubscribe). Our same-origin RPC proxy (trapwars.win/api/rpc) only
// speaks HTTP, so the WS never connects and confirmTransaction() hangs forever
// — this is what stuck battle creation on "Creating battle...".
//
// This helper polls getSignatureStatus over plain HTTP instead, which works
// through the proxy and inside wallet in-app browsers.
export async function confirmSignature(connection, signature, {
  commitment = 'confirmed',
  timeoutMs = 60000,
  pollMs = 1500,
} = {}) {
  const start = Date.now();
  const wantFinal = commitment === 'finalized';

  while (Date.now() - start < timeoutMs) {
    let status;
    try {
      const res = await connection.getSignatureStatus(signature, {
        searchTransactionHistory: true,
      });
      status = res && res.value;
    } catch (_) {
      // transient RPC hiccup — keep polling
    }

    if (status) {
      if (status.err) {
        throw new Error('Transaction failed on-chain: ' + JSON.stringify(status.err));
      }
      const cs = status.confirmationStatus;
      if (cs === 'finalized' || (!wantFinal && (cs === 'confirmed' || cs === 'finalized'))) {
        return status;
      }
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error('Confirmation timed out. The transaction may still succeed — check your wallet.');
}
