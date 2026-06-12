// Cloudflare Pages Function: same-origin proxy for the Trap Wars signer/RPC.
//
// Phantom/Solflare in-app browsers (WebKit) block or fail cross-origin fetches
// to api.trapwars.win ("TypeError: Load failed" / "failed to get recent
// blockhash"), even with correct CORS. Serving the API from the SAME origin
// (trapwars.win/api/*) eliminates the cross-origin fetch entirely.
//
// /api/rpc      -> https://api.trapwars.win/rpc
// /api/health   -> https://api.trapwars.win/health
// /api/battle/* -> https://api.trapwars.win/battle/*
const UPSTREAM = 'https://api.trapwars.win';

export async function onRequest(context) {
  const { request, params } = context;
  const url = new URL(request.url);

  // params.path is the wildcard segments after /api/
  const sub = Array.isArray(params.path) ? params.path.join('/') : (params.path || '');
  const target = `${UPSTREAM}/${sub}${url.search}`;

  // Preflight — answer same-origin so the webview never blocks.
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // Forward method + body + content-type to the upstream signer.
  const init = {
    method: request.method,
    headers: { 'Content-Type': request.headers.get('Content-Type') || 'application/json' },
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.text();
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(target, init);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'proxy_fetch_failed', detail: String(e) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // Relay the body, force same-origin-friendly CORS.
  const body = await upstreamRes.arrayBuffer();
  const headers = new Headers();
  headers.set('Content-Type', upstreamRes.headers.get('Content-Type') || 'application/json');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cache-Control', 'no-store');

  return new Response(body, { status: upstreamRes.status, headers });
}
