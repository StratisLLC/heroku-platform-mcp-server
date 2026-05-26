/**
 * Apps-tier write tools — custom domains and SNI endpoints.
 *
 * Tools registered here:
 *   - domains_create        (POST)
 *   - domains_update        (PATCH)
 *   - domains_delete        (⚠ DELETE; confirm: <hostname>)
 *   - sni_endpoints_create  (POST)
 *   - sni_endpoints_update  (PATCH)
 *   - sni_endpoints_delete  (⚠ DELETE; confirm: <endpoint name>)
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import type { HerokuRecord } from '../tool-helpers.js';
import { registerWriteTool } from '../write-tool.js';

const url = (s: string): string => encodeURIComponent(s);

const appInput = {
  app: z.string().min(1).describe('App id or name. Prefer UUID when known.'),
};

const domainsCreateShape = {
  ...appInput,
  hostname: z.string().min(1).describe('Custom domain hostname (e.g. "www.example.com").'),
  sni_endpoint: z
    .string()
    .min(1)
    .optional()
    .describe('Optional SNI endpoint id or name to associate.'),
};

const domainsUpdateShape = {
  ...appInput,
  domain: z.string().min(1).describe('Domain id or hostname.'),
  sni_endpoint: z
    .string()
    .nullable()
    .optional()
    .describe('SNI endpoint id or name to attach. Pass null to detach. Omit to leave unchanged.'),
};

const domainsDeleteShape = {
  ...appInput,
  domain: z.string().min(1).describe('Domain id or hostname.'),
};

const sniCreateShape = {
  ...appInput,
  certificate_chain: z.string().min(1).describe('PEM-encoded certificate chain.'),
  private_key: z.string().min(1).describe('PEM-encoded private key.'),
};

const sniUpdateShape = {
  ...appInput,
  endpoint: z.string().min(1).describe('SNI endpoint id or name.'),
  certificate_chain: z.string().min(1).describe('PEM-encoded certificate chain.'),
  private_key: z.string().min(1).describe('PEM-encoded private key.'),
};

const sniDeleteShape = {
  ...appInput,
  endpoint: z.string().min(1).describe('SNI endpoint id or name.'),
};

export function registerDomainsWriteTools(server: McpServer, ctx: ToolContext): void {
  registerWriteTool<typeof domainsCreateShape, HerokuRecord>(server, ctx, {
    name: 'domains_create',
    title: 'Create domain',
    description:
      'Add a custom domain to an app. Wraps POST /apps/{id_or_name}/domains. The user is responsible for the matching DNS CNAME.',
    inputSchema: domainsCreateShape,
    build: (args) => {
      const body: Record<string, unknown> = { hostname: args.hostname };
      if (args.sni_endpoint !== undefined) body.sni_endpoint = args.sni_endpoint;
      return { method: 'POST', path: `/apps/${url(args.app)}/domains`, body };
    },
    describe: (args) =>
      `Would add domain '${args.hostname}' to app '${args.app}'${
        args.sni_endpoint ? ` attached to SNI endpoint '${args.sni_endpoint}'` : ''
      }.`,
  });

  registerWriteTool<typeof domainsUpdateShape, HerokuRecord>(server, ctx, {
    name: 'domains_update',
    title: 'Update domain',
    description:
      'Update a custom domain. Today this is mostly used to (re)attach or detach an SNI endpoint. Wraps PATCH /apps/{id_or_name}/domains/{id_or_hostname}.',
    inputSchema: domainsUpdateShape,
    build: (args) => {
      const body: Record<string, unknown> = {};
      if (args.sni_endpoint !== undefined) body.sni_endpoint = args.sni_endpoint;
      return {
        method: 'PATCH',
        path: `/apps/${url(args.app)}/domains/${url(args.domain)}`,
        body,
      };
    },
    describe: (args) => {
      if (args.sni_endpoint === null) {
        return `Would detach SNI endpoint from domain '${args.domain}' on app '${args.app}'.`;
      }
      if (args.sni_endpoint !== undefined) {
        return `Would attach SNI endpoint '${args.sni_endpoint}' to domain '${args.domain}' on app '${args.app}'.`;
      }
      return `Would update domain '${args.domain}' on app '${args.app}' (no fields changed).`;
    },
  });

  registerWriteTool<typeof domainsDeleteShape, HerokuRecord>(server, ctx, {
    name: 'domains_delete',
    title: 'Delete domain',
    description:
      'Remove a custom domain from an app. Wraps DELETE /apps/{id_or_name}/domains/{id_or_hostname}. Destructive: pass confirm matching the hostname.',
    inputSchema: domainsDeleteShape,
    destructive: {
      targetKind: 'domain',
      expectedFromResource: (resource) =>
        typeof resource?.hostname === 'string' ? resource.hostname : undefined,
      expectedFromArgs: (args) => args.domain,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/apps/${url(args.app)}/domains/${url(args.domain)}`, {
          tool: 'domains_delete',
        }),
    },
    build: (args) => ({
      method: 'DELETE',
      path: `/apps/${url(args.app)}/domains/${url(args.domain)}`,
    }),
    describe: (args, fetched) => {
      const hostname = typeof fetched?.hostname === 'string' ? fetched.hostname : args.domain;
      const cname = typeof fetched?.cname === 'string' ? ` (CNAME ${fetched.cname})` : '';
      return `Would remove domain '${hostname}'${cname} from app '${args.app}'. DNS pointing at the Heroku CNAME will start failing.`;
    },
  });

  registerWriteTool<typeof sniCreateShape, HerokuRecord>(server, ctx, {
    name: 'sni_endpoints_create',
    title: 'Create SNI endpoint',
    description:
      'Upload a TLS certificate + private key as an SNI endpoint. Wraps POST /apps/{id_or_name}/sni-endpoints. Certificate material is sent verbatim to Heroku and not stored locally.',
    inputSchema: sniCreateShape,
    build: (args) => ({
      method: 'POST',
      path: `/apps/${url(args.app)}/sni-endpoints`,
      body: { certificate_chain: args.certificate_chain, private_key: args.private_key },
    }),
    describe: (args) => `Would upload a new SNI endpoint (certificate + key) to app '${args.app}'.`,
  });

  registerWriteTool<typeof sniUpdateShape, HerokuRecord>(server, ctx, {
    name: 'sni_endpoints_update',
    title: 'Update SNI endpoint',
    description:
      'Replace the certificate + key on an existing SNI endpoint. Wraps PATCH /apps/{id_or_name}/sni-endpoints/{id_or_name}.',
    inputSchema: sniUpdateShape,
    build: (args) => ({
      method: 'PATCH',
      path: `/apps/${url(args.app)}/sni-endpoints/${url(args.endpoint)}`,
      body: { certificate_chain: args.certificate_chain, private_key: args.private_key },
    }),
    describe: (args) =>
      `Would replace the certificate + key on SNI endpoint '${args.endpoint}' (app '${args.app}').`,
  });

  registerWriteTool<typeof sniDeleteShape, HerokuRecord>(server, ctx, {
    name: 'sni_endpoints_delete',
    title: 'Delete SNI endpoint',
    description:
      'Remove an SNI endpoint from an app. Wraps DELETE /apps/{id_or_name}/sni-endpoints/{id_or_name}. Destructive: pass confirm matching the endpoint name.',
    inputSchema: sniDeleteShape,
    destructive: {
      targetKind: 'endpoint',
      expectedFromResource: (resource) =>
        typeof resource?.name === 'string' ? resource.name : undefined,
      expectedFromArgs: (args) => args.endpoint,
    },
    preFetch: {
      run: (args) =>
        ctx.client.get<HerokuRecord>(`/apps/${url(args.app)}/sni-endpoints/${url(args.endpoint)}`, {
          tool: 'sni_endpoints_delete',
        }),
    },
    build: (args) => ({
      method: 'DELETE',
      path: `/apps/${url(args.app)}/sni-endpoints/${url(args.endpoint)}`,
    }),
    describe: (args, fetched) => {
      const name = typeof fetched?.name === 'string' ? fetched.name : args.endpoint;
      return `Would delete SNI endpoint '${name}' from app '${args.app}'. Domains attached to it will fall back to default TLS.`;
    },
  });
}
