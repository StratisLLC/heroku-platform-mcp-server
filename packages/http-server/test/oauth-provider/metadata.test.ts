/**
 * Tests for the .well-known OAuth metadata endpoints (RFC 8414 + RFC 9728).
 */

import { describe, expect, it } from 'vitest';
import { buildRig } from '../helpers/wiring.js';
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from '../../src/routes/wellknown.js';

describe('buildAuthorizationServerMetadata', () => {
  it('emits absolute URLs derived from publicUrl', () => {
    const md = buildAuthorizationServerMetadata('https://srv.example');
    expect(md.issuer).toBe('https://srv.example');
    expect(md.authorization_endpoint).toBe('https://srv.example/oauth/authorize');
    expect(md.token_endpoint).toBe('https://srv.example/oauth/token');
    expect(md.registration_endpoint).toBe('https://srv.example/oauth/register');
    expect(md.revocation_endpoint).toBe('https://srv.example/oauth/revoke');
  });

  it('declares the supported response_types, grant_types, and PKCE method', () => {
    const md = buildAuthorizationServerMetadata('https://srv');
    expect(md.response_types_supported).toEqual(['code']);
    expect(md.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(md.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('trims a trailing slash from publicUrl', () => {
    const md = buildAuthorizationServerMetadata('https://srv.example/');
    expect(md.issuer).toBe('https://srv.example');
    expect(md.token_endpoint).toBe('https://srv.example/oauth/token');
  });
});

describe('buildProtectedResourceMetadata', () => {
  it('points to /mcp and our authorization server', () => {
    const md = buildProtectedResourceMetadata('https://srv.example');
    expect(md.resource).toBe('https://srv.example/mcp');
    expect(md.authorization_servers).toEqual(['https://srv.example']);
    expect(md.bearer_methods_supported).toEqual(['header']);
  });
});

describe('/.well-known endpoints', () => {
  it('GET /.well-known/oauth-authorization-server returns JSON metadata', async () => {
    const rig = buildRig();
    const res = await rig.app.request('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { issuer: string; token_endpoint: string };
    expect(body.issuer).toBe('https://test.example.com');
    expect(body.token_endpoint).toBe('https://test.example.com/oauth/token');
  });

  it('GET /.well-known/oauth-protected-resource returns JSON metadata', async () => {
    const rig = buildRig();
    const res = await rig.app.request('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string };
    expect(body.resource).toBe('https://test.example.com/mcp');
  });

  it('metadata endpoints do not require authentication', async () => {
    const rig = buildRig();
    // No cookie, no bearer — must still work.
    const a = await rig.app.request('/.well-known/oauth-authorization-server');
    const b = await rig.app.request('/.well-known/oauth-protected-resource');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});
