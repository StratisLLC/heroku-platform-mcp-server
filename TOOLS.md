# Heroku MCP — Tool Catalog

> The exhaustive list of tools exposed by each server, grouped by capability tier. Each entry shows: tool name, the Heroku endpoint(s) wrapped, required and optional parameters, and behavior flags.
>
> Legend:
> - ⚠ = destructive; requires `confirm` matching target name
> - 🔒 = OTP/password-gated; hidden unless `--allow-account-deletion` (or equivalent flag) given at startup
> - 🧪 = supports `dry_run: true`
> - 📄 = supports pagination (`page_size`, `cursor`)
> - 🏷 = supports `expected_etag` for optimistic concurrency

All tools also accept a hidden `_meta` parameter for host telemetry passthrough (ignored by the server logic).

## Phase 2a notes — `dry_run` and `confirm` patterns

Every mutating tool accepts `dry_run: boolean` (default `false`). When `dry_run: true`:

- Inputs are validated and the would-be HTTP request is built.
- For **DELETE** operations, the resource's current state is fetched via the matching GET endpoint and surfaced in the response's `description` field (owner, region, stack, created-at for apps; service/plan/attachment for add-ons; hostname/CNAME for domains; etc.). If the pre-fetch fails (404/403), the dry-run returns that error rather than simulating a fake request.
- The response shape is `{ ok: true, data: { request: { method, url, headers, body }, description }, meta: {...} }`. The `Authorization` header is stripped from the preview's `headers` map.
- No request is issued to Heroku.

Destructive tools (⚠) additionally require `confirm: string`. The model must NOT auto-fill `confirm` from the same user turn that requested the destructive op — the verbal confirmation in chat is the audit trail. When `confirm` is missing or mismatched (case-sensitive), the tool returns a structured `confirmation_required` envelope (`{ ok: false, error: { kind: 'confirmation', details: { kind: 'confirmation_required', expected, target_kind, reason } } }`) without making the API call.

When both `dry_run: true` and `confirm` are passed, the dry-run wins — no real request is issued, and the `confirm` value is not validated.

The per-tool expected `confirm` value is documented in the Params column where the ⚠ marker appears.

---

# `heroku-platform-mcp` (Customer)

## Diagnostic — always on

| Tool | Wraps | Params | Notes |
|---|---|---|---|
| `whoami` | `GET /account` | — | Returns email, id, federated status, default team. |
| `refresh_capabilities` | (none — re-runs prober) | `force?: boolean` | Re-probes; emits `notifications/tools/list_changed`. |
| `rate_limit_status` | `GET /account/rate-limits` | — | Doesn't consume rate-limit budget. |
| `audit_tail` | (local) | `limit?: number` (default 50) | Reads recent audit log entries. |
| `schema_info` | (cached) | — | Returns Heroku schema version + when it was last fetched. |

## Tier: `account`

> Account deletion is intentionally not exposed; use the Heroku Dashboard. The Heroku `DELETE /account` endpoint requires the user's password as a header and has dangerous consequences, so it's omitted by design (Phase 2b Decision 1).

| Tool | Wraps | Params |
|---|---|---|
| `account_info` | `GET /account` | — |
| `account_update` 🧪 | `PATCH /account` | `name?`, `beta?`, `allow_tracking?` |
| `account_delinquency_info` | `GET /account/delinquency` | — |
| `account_features_list` 📄 | `GET /account/features` | — |
| `account_features_update` 🧪 | `PATCH /account/features/{id_or_name}` | `feature: string`, `enabled: boolean` |
| `account_sms_number_get` | `GET /account/sms-number` | — |
| `account_sms_number_recover` 🧪 | `POST /account/sms-number/actions/recover` | — |
| `keys_list` 📄 | `GET /account/keys` | — |
| `keys_info` | `GET /account/keys/{id_or_fingerprint}` | `key: string` |
| `keys_create` 🧪 | `POST /account/keys` | `public_key: string` |
| `keys_delete` ⚠🧪 | `DELETE /account/keys/{id_or_fingerprint}` | `key: string`, `fingerprint: string`, `confirm: <fingerprint>` |
| `oauth_authorizations_list` 📄 | `GET /oauth/authorizations` | — |
| `oauth_authorizations_info` | `GET /oauth/authorizations/{id}` | `id: string` |
| `oauth_authorizations_create` 🧪 | `POST /oauth/authorizations` | `description?`, `scope?: string[]`, `expires_in?: number`, `client?: string` |
| `oauth_authorizations_delete` ⚠🧪 | `DELETE /oauth/authorizations/{id}` | `id: string`, `confirm_target: string`, `confirm: <description-or-id>` |
| `oauth_authorizations_regenerate` ⚠🧪 | `POST /oauth/authorizations/{id}/actions/regenerate-tokens` | `id: string`, `confirm: <id>` |
| `oauth_clients_list` 📄 | `GET /oauth/clients` | — |
| `oauth_clients_info` | `GET /oauth/clients/{id}` | — |
| `invoices_list` 📄 | `GET /account/invoices` | — |
| `invoices_info` | `GET /account/invoices/{number}` | `number: number` |
| `invoice_address_info` | `GET /account/invoice-address` | — |
| `invoice_address_update` 🧪 | `PUT /account/invoice-address` | address fields |
| `credits_list` 📄 | `GET /account/credits` | — |
| `credits_create` 🧪 | `POST /account/credits` | `code: string`, `amount?: number` |
| `user_preferences_get` | `GET /users/~/preferences` | — |
| `user_preferences_update` 🧪 | `PATCH /users/~/preferences` | `preferences: object` |

> `oauth_tokens_create` is a token-issuance flow used during OAuth grants and is intentionally deferred — it is not a typical "write the model performs" tool. The Partner MCP exposes the grant-exchange tools in Phase 4.

## Tier: `apps`

### Apps

| Tool | Wraps | Params |
|---|---|---|
| `apps_list` 📄 | `GET /apps` | sort, filter |
| `apps_list_owned` 📄 | `GET /users/~/apps` | — |
| `apps_info` | `GET /apps/{id_or_name}` | `app: string` |
| `apps_create` 🧪 | `POST /apps` | `name?`, `region?`, `stack?` |
| `apps_update` 🧪🏷 | `PATCH /apps/{id_or_name}` | `app`, `name?`, `maintenance?`, `build_stack?` |
| `apps_delete` ⚠ | `DELETE /apps/{id_or_name}` | `app`, `confirm: <name>` |
| `apps_filter` 📄 | `POST /filters/apps` | `in: { id: string[] }` |

> `apps_filter` is semantically a read (no state change) but wraps `POST` because the filter criteria — an arbitrary list of app IDs — would not fit in a URL. Treated as a list tool for tier/diagnostic gating.
| `apps_enable_acm` 🧪 | `POST /apps/{id_or_name}/acm` | `app` |
| `apps_disable_acm` ⚠ | `DELETE /apps/{id_or_name}/acm` | `app`, `confirm: <name>` |
| `apps_refresh_acm` 🧪 | `PATCH /apps/{id_or_name}/acm` | `app` |

### App Features

| Tool | Wraps | Params |
|---|---|---|
| `app_features_list` 📄 | `GET /apps/{id_or_name}/features` | `app` |
| `app_features_info` | `GET /apps/{id_or_name}/features/{feature}` | `app`, `feature` |
| `app_features_update` 🧪 | `PATCH /apps/{id_or_name}/features/{feature}` | `app`, `feature`, `enabled: boolean` |

### Config Vars

| Tool | Wraps | Params |
|---|---|---|
| `config_vars_get` | `GET /apps/{id_or_name}/config-vars` | `app` |
| `config_vars_update` 🧪 | `PATCH /apps/{id_or_name}/config-vars` | `app`, `config: Record<string, string\|null>` (null deletes) |
| `config_vars_get_release` | `GET /apps/{id_or_name}/releases/{release}/config-vars` | `app`, `release` |

### Formation & Dynos

| Tool | Wraps | Params |
|---|---|---|
| `formation_list` | `GET /apps/{id_or_name}/formation` | `app` |
| `formation_info` | `GET /apps/{id_or_name}/formation/{type}` | `app`, `type` |
| `formation_scale` 🧪 | `PATCH /apps/{id_or_name}/formation` | `app`, `updates: [{type, quantity?, size?}]` |
| `dyno_sizes_list` | `GET /dyno-sizes` | — |
| `dynos_list` 📄 | `GET /apps/{id_or_name}/dynos` | `app` |
| `dynos_info` | `GET /apps/{id_or_name}/dynos/{id_or_name}` | `app`, `dyno` |
| `dynos_run` 🧪 | `POST /apps/{id_or_name}/dynos` | `app`, `command`, `attach?`, `env?`, `size?`, `type?`, `time_to_live?` — returns dyno metadata only; rendezvous output streaming is deferred to Phase 4 (HTTP transport). |
| `dynos_restart` ⚠ | `DELETE /apps/{id_or_name}/dynos/{id_or_name}` | `app`, `dyno`, `confirm: <app>` |
| `dynos_restart_all` ⚠ | `DELETE /apps/{id_or_name}/dynos` | `app`, `confirm: <app>` |
| `dynos_stop` ⚠ | `POST /apps/{id_or_name}/dynos/{id_or_name}/actions/stop` | `app`, `dyno`, `confirm: <dyno>` |

### Releases

| Tool | Wraps | Params |
|---|---|---|
| `releases_list` 📄 | `GET /apps/{id_or_name}/releases` | `app` |
| `releases_info` | `GET /apps/{id_or_name}/releases/{id_or_version}` | `app`, `release` |
| `releases_create` 🧪 | `POST /apps/{id_or_name}/releases` | `app`, `slug`, `description?` |
| `releases_rollback` ⚠🧪 | `POST /apps/{id_or_name}/releases` | `app`, `release: <version>`, `confirm: <app>` |
| `releases_output_get` | `GET /releases/{id}/output` | `release` |

### Builds & Slugs

| Tool | Wraps | Params |
|---|---|---|
| `builds_list` 📄 | `GET /apps/{id_or_name}/builds` | `app` |
| `builds_info` | `GET /apps/{id_or_name}/builds/{id}` | `app`, `build` |
| `builds_create` 🧪 | `POST /apps/{id_or_name}/builds` | `app`, `source_blob: {url, version?, checksum?}`, `buildpacks?` |
| `builds_delete_cache` ⚠ | `DELETE /apps/{id_or_name}/build-cache` | `app`, `confirm: <app>` |
| `buildpack_installations_list` 📄 | `GET /apps/{id_or_name}/buildpack-installations` | `app` |
| `buildpack_installations_update` 🧪 | `PUT /apps/{id_or_name}/buildpack-installations` | `app`, `updates: [{buildpack}]` |
| `slugs_info` | `GET /apps/{id_or_name}/slugs/{id}` | `app`, `slug` |
| `slugs_create` 🧪 | `POST /apps/{id_or_name}/slugs` | `app`, `process_types`, `checksum?`, `commit?`, `stack?` |
| `source_create` | `POST /sources` | — |
| `oci_image_create` | `POST /apps/{id_or_name}/oci-images` | `app`, image params |
| `oci_image_info` | `GET /apps/{id_or_name}/oci-images/{id}` | `app`, `image` |

### Domains & SSL

| Tool | Wraps | Params |
|---|---|---|
| `domains_list` 📄 | `GET /apps/{id_or_name}/domains` | `app` |
| `domains_info` | `GET /apps/{id_or_name}/domains/{id_or_hostname}` | `app`, `domain` |
| `domains_create` 🧪 | `POST /apps/{id_or_name}/domains` | `app`, `hostname`, `sni_endpoint?` |
| `domains_update` 🧪 | `PATCH /apps/{id_or_name}/domains/{id_or_hostname}` | `app`, `domain`, `sni_endpoint?` |
| `domains_delete` ⚠ | `DELETE /apps/{id_or_name}/domains/{id_or_hostname}` | `app`, `domain`, `confirm: <hostname>` |
| `sni_endpoints_list` 📄 | `GET /apps/{id_or_name}/sni-endpoints` | `app` |
| `sni_endpoints_info` | `GET /apps/{id_or_name}/sni-endpoints/{id_or_name}` | `app`, `endpoint` |
| `sni_endpoints_create` 🧪 | `POST /apps/{id_or_name}/sni-endpoints` | `app`, `certificate_chain`, `private_key` |
| `sni_endpoints_update` 🧪 | `PATCH /apps/{id_or_name}/sni-endpoints/{id_or_name}` | `app`, `endpoint`, cert + key |
| `sni_endpoints_delete` ⚠ | `DELETE /apps/{id_or_name}/sni-endpoints/{id_or_name}` | `app`, `endpoint`, `confirm: <name>` |

### Logs

| Tool | Wraps | Params |
|---|---|---|
| `log_sessions_create` | `POST /apps/{id_or_name}/log-sessions` | `app`, `dyno?`, `source?`, `lines?`, `tail?` |
| `log_drains_list` 📄 | `GET /apps/{id_or_name}/log-drains` | `app` |
| `log_drains_info` | `GET /apps/{id_or_name}/log-drains/{id_or_url_or_token}` | `app`, `drain` |
| `log_drains_create` 🧪 | `POST /apps/{id_or_name}/log-drains` | `app`, `url` |
| `log_drains_delete` ⚠ | `DELETE /apps/{id_or_name}/log-drains/{id_or_url_or_token}` | `app`, `drain`, `confirm: <app>` |
| `telemetry_drains_list` 📄 | `GET /telemetry-drains` | — (account-scoped) |
| `telemetry_drains_create` 🧪 | `POST /apps/{id_or_name}/telemetry-drains` | `app`, drain params |
| `telemetry_drains_update` 🧪 | `PATCH /telemetry-drains/{id}` | drain params |
| `telemetry_drains_delete` ⚠ | `DELETE /telemetry-drains/{id}` | `id`, `confirm: <id>` |

> `telemetry_drains_list`, `telemetry_drains_update`, and `telemetry_drains_delete` are account-scoped — addressed by the drain id rather than by app. Only `telemetry_drains_create` is per-app (`POST /apps/{app}/telemetry-drains`); updates and deletes use the global `/telemetry-drains/{id}` path.

### Webhooks

| Tool | Wraps | Params |
|---|---|---|
| `app_webhooks_list` 📄 | `GET /apps/{id_or_name}/webhooks` | `app` |
| `app_webhooks_info` | `GET /apps/{id_or_name}/webhooks/{id}` | `app`, `webhook` |
| `app_webhooks_create` 🧪 | `POST /apps/{id_or_name}/webhooks` | `app`, `url`, `include`, `level`, `secret?`, `authorization?` |
| `app_webhooks_update` 🧪 | `PATCH /apps/{id_or_name}/webhooks/{id}` | `app`, `webhook`, update fields |
| `app_webhooks_delete` ⚠ | `DELETE /apps/{id_or_name}/webhooks/{id}` | `app`, `webhook`, `confirm: <app>` |
| `app_webhook_deliveries_list` 📄 | `GET /apps/{id_or_name}/webhook-deliveries` | `app` |
| `app_webhook_deliveries_info` | `GET /apps/{id_or_name}/webhook-deliveries/{id}` | `app`, `delivery` |
| `app_webhook_events_list` 📄 | `GET /apps/{id_or_name}/webhook-events` | `app` |
| `app_webhook_events_info` | `GET /apps/{id_or_name}/webhook-events/{id}` | `app`, `event` |

### Collaborators & Transfers

| Tool | Wraps | Params |
|---|---|---|
| `collaborators_list` 📄 | `GET /apps/{id_or_name}/collaborators` | `app` |
| `collaborators_info` | `GET /apps/{id_or_name}/collaborators/{id_or_email}` | `app`, `collaborator` |
| `collaborators_create` 🧪 | `POST /apps/{id_or_name}/collaborators` | `app`, `user`, `silent?` |
| `collaborators_delete` ⚠ | `DELETE /apps/{id_or_name}/collaborators/{id_or_email}` | `app`, `collaborator`, `confirm: <email>` |
| `app_transfers_list` 📄 | `GET /account/app-transfers` | — |
| `app_transfers_info` | `GET /account/app-transfers/{id_or_name}` | `transfer` |
| `app_transfers_create` 🧪 | `POST /account/app-transfers` | `app`, `recipient`, `silent?` |
| `app_transfers_update` ⚠🧪 | `PATCH /account/app-transfers/{id_or_name}` | `transfer`, `state`, `confirm: <app>` |
| `app_transfers_delete` ⚠ | `DELETE /account/app-transfers/{id_or_name}` | `transfer`, `confirm: <app>` |

### Review Apps

| Tool | Wraps | Params |
|---|---|---|
| `review_apps_list` 📄 | `GET /pipelines/{id_or_name}/review-apps` | `pipeline` |
| `review_apps_info` | `GET /review-apps/{id}` | `review_app` |
| `review_apps_create` 🧪 | `POST /review-apps` | `branch`, `pipeline`, `source_blob`, … |
| `review_apps_delete` ⚠ | `DELETE /review-apps/{id}` | `review_app`, `confirm: <id>` |
| `review_apps_config_get` | `GET /pipelines/{id_or_name}/review-app-config` | `pipeline` |
| `review_apps_config_create` 🧪 | `POST /pipelines/{id_or_name}/review-app-config` | `pipeline`, config fields |
| `review_apps_config_update` 🧪 | `PATCH /pipelines/{id_or_name}/review-app-config` | `pipeline`, config fields |
| `review_apps_config_delete` ⚠ | `DELETE /pipelines/{id_or_name}/review-app-config` | `pipeline`, `confirm: <pipeline>` |
| `app_setups_create` 🧪 | `POST /app-setups` | source + overrides |
| `app_setups_info` | `GET /app-setups/{id}` | `setup` |

## Tier: `teams`

> **Deprecation context for `teams_create` and `teams_delete`:** the Heroku CLI removed its `teams:create` and `teams:destroy` commands because Heroku now recommends creating/deleting teams through an Enterprise account dashboard (a separate endpoint at `POST /enterprise-accounts/{id}/teams`, exposed in a later phase). The Platform API endpoints these tools wrap still work and create/destroy standalone (non-enterprise) teams. Use these tools when the user specifically wants a standalone team; for enterprise users, prefer the enterprise team tools when they become available. The deprecation context is included verbatim in each tool's description.
>
> Phase 2b Decision 7: the teams tier lights up even when `teams.list` returns `200 []`. Tools that operate on individual teams (`teams_info`, `team_members_list`, etc.) return 404 from Heroku if called with a nonexistent team name; the existing error mapping surfaces those correctly.
>
> Phase 2b Decision 8: list-style tools in this tier (`teams_list`, `team_members_list`, etc.) all support pagination. Heroku's default page size on `/teams` is 25; pass `page_size` to retrieve larger batches in one call.
>
> Allowed add-on services live under the teams tier in the Platform API even though they're listed under `addons_consumer` for catalog completeness; the three `allowed_addon_services_*` tools below ship with the teams tier.

| Tool | Wraps | Params |
|---|---|---|
| `teams_list` 📄 | `GET /teams` | — |
| `teams_info` | `GET /teams/{id_or_name}` | `team` |
| `teams_create` 🧪 | `POST /teams` | `name`, `address_1?`, etc. |
| `teams_update` 🧪 | `PATCH /teams/{id_or_name}` | `team`, `name?`, `default?` |
| `teams_delete` ⚠🧪 | `DELETE /teams/{id_or_name}` | `team`, `confirm: <name>` |
| `team_members_list` 📄 | `GET /teams/{id_or_name}/members` | `team` |
| `team_members_create_or_update` 🧪 | `PUT /teams/{id_or_name}/members` | `team`, `email`, `role`, `federated?` |
| `team_members_delete` ⚠🧪 | `DELETE /teams/{id_or_name}/members/{email_or_id}` | `team`, `member`, `confirm: <email>` |
| `team_members_apps_list` 📄 | `GET /teams/{id_or_name}/members/{email_or_id}/apps` | `team`, `member` |
| `team_apps_list` 📄 | `GET /teams/{id_or_name}/apps` | `team` |
| `team_apps_info` | `GET /teams/apps/{id_or_name}` | `app` |
| `team_apps_create` 🧪 | `POST /teams/apps` | `team`, `name?`, `region?`, `stack?`, `locked?`, … |
| `team_apps_update_locked` 🧪 | `PATCH /teams/apps/{id_or_name}` | `app`, `locked` |
| `team_apps_transfer` ⚠🧪 | `PATCH /teams/apps/{id_or_name}` | `app`, `owner`, `confirm: <app>` |
| `team_app_collaborators_list` 📄 | `GET /teams/apps/{id_or_name}/collaborators` | `app` |
| `team_app_collaborators_create` 🧪 | `POST /teams/apps/{id_or_name}/collaborators` | `app`, `user`, `permissions?[]`, `silent?` |
| `team_app_collaborators_update` 🧪 | `PATCH /teams/apps/{id_or_name}/collaborators/{email}` | `app`, `email`, `permissions[]` |
| `team_app_collaborators_delete` ⚠🧪 | `DELETE /teams/apps/{id_or_name}/collaborators/{email}` | `app`, `email`, `confirm: <email>` |
| `team_app_permissions_list` | `GET /teams/permissions` | — |
| `team_invitations_list` 📄 | `GET /teams/{id_or_name}/invitations` | `team` |
| `team_invitations_create` 🧪 | `PUT /teams/{id_or_name}/invitations` | `team`, `email`, `role` |
| `team_invitations_accept` 🧪 | `POST /teams/invitations/{token}/accept` | `token` |
| `team_invitations_revoke` ⚠🧪 | `DELETE /teams/{id_or_name}/invitations/{user}` | `team`, `user`, `confirm: <email>` |
| `team_invoices_list` 📄 | `GET /teams/{id_or_name}/invoices` | `team` |
| `team_invoices_info` | `GET /teams/{id_or_name}/invoices/{number}` | `team`, `number` |
| `team_daily_usage` | `GET /teams/{id_or_name}/usage/daily` | `team`, `start`, `end` |
| `team_monthly_usage` | `GET /teams/{id_or_name}/usage/monthly` | `team`, `start`, `end` |
| `team_features_list` 📄 | `GET /teams/{id_or_name}/features` | `team` |
| `team_features_info` | `GET /teams/{id_or_name}/features/{id_or_name}` | `team`, `feature` |
| `team_features_update` 🧪 | `PATCH /teams/{id_or_name}/features/{id_or_name}` | `team`, `feature`, `enabled` |
| `team_addons_list` 📄 | `GET /teams/{id_or_name}/addons` | `team` |
| `team_preferences_get` | `GET /teams/{id_or_name}/preferences` | `team` |
| `team_preferences_update` 🧪 | `PATCH /teams/{id_or_name}/preferences` | `team`, `preferences: object` |
| `team_spaces_list` 📄 | `GET /teams/{id_or_name}/spaces` | `team` |
| `team_delinquency_info` | `GET /teams/{id_or_name}/delinquency` | `team` |
| `allowed_addon_services_list` 📄 | `GET /teams/{id_or_name}/allowed-addon-services` | `team` |
| `allowed_addon_services_create` 🧪 | `POST /teams/{id_or_name}/allowed-addon-services` | `team`, `addon_service` |
| `allowed_addon_services_delete` ⚠🧪 | `DELETE /teams/{id_or_name}/allowed-addon-services/{id_or_name}` | `team`, `service`, `confirm: <name>` |

## Tier: `enterprise`

| Tool | Wraps | Params |
|---|---|---|
| `enterprise_accounts_list` 📄 | `GET /enterprise-accounts` | — |
| `enterprise_account_info` | `GET /enterprise-accounts/{id_or_name}` | `enterprise` |
| `enterprise_account_update` 🧪 | `PATCH /enterprise-accounts/{id_or_name}` | `enterprise`, fields |
| `enterprise_members_list` 📄 | `GET /enterprise-accounts/{id_or_name}/members` | `enterprise` |
| `enterprise_members_create` 🧪 | `POST /enterprise-accounts/{id_or_name}/members` | `enterprise`, `email`, `permissions[]`, `federated?` |
| `enterprise_members_update` 🧪 | `PATCH /enterprise-accounts/{id_or_name}/members/{user}` | `enterprise`, `user`, `permissions[]` |
| `enterprise_members_delete` ⚠ | `DELETE /enterprise-accounts/{id_or_name}/members/{user}` | `enterprise`, `user`, `confirm: <email>` |
| `enterprise_daily_usage` | `GET /enterprise-accounts/{id_or_name}/usage/daily` | `enterprise`, `start`, `end` |
| `enterprise_monthly_usage` | `GET /enterprise-accounts/{id_or_name}/usage/monthly` | `enterprise`, `start`, `end` |
| `permission_entities_list` 📄 | `GET /enterprise-accounts/{id_or_name}/permissions` | `enterprise` |
| `identity_providers_list` 📄 | `GET /enterprise-accounts/{id_or_name}/identity-providers` | `enterprise` |
| `identity_providers_info` | `GET /enterprise-accounts/{id_or_name}/identity-providers/{id}` | `enterprise`, `provider` |
| `identity_providers_create` 🧪 | `POST /enterprise-accounts/{id_or_name}/identity-providers` | `enterprise`, IdP fields |
| `identity_providers_update` 🧪 | `PATCH /identity-providers/{id}` | `provider`, fields |
| `identity_providers_delete` ⚠ | `DELETE /identity-providers/{id}` | `provider`, `confirm: <name>` |
| `audit_trail_events_list` 📄 | `GET /enterprise-accounts/{id_or_name}/events` | `enterprise`, time range filters |
| `audit_trail_archives_list` 📄 | `GET /enterprise-accounts/{id_or_name}/archives` | `enterprise` |
| `audit_trail_archives_info` | `GET /enterprise-accounts/{id_or_name}/archives/{year}/{month}` | `enterprise`, `year`, `month` |

## Tier: `spaces`

| Tool | Wraps | Params |
|---|---|---|
| `spaces_list` 📄 | `GET /spaces` | — |
| `spaces_info` | `GET /spaces/{id_or_name}` | `space` |
| `spaces_create` 🧪 | `POST /spaces` | `name`, `team`, `region?`, `shield?`, `cidr?`, `data_cidr?` |
| `spaces_update` 🧪 | `PATCH /spaces/{id_or_name}` | `space`, `name?` |
| `spaces_delete` ⚠ | `DELETE /spaces/{id_or_name}` | `space`, `confirm: <name>` |
| `space_access_list` 📄 | `GET /spaces/{id_or_name}/members` | `space` |
| `space_access_info` | `GET /spaces/{id_or_name}/members/{user}` | `space`, `user` |
| `space_access_update` 🧪 | `PATCH /spaces/{id_or_name}/members/{user}` | `space`, `user`, `permissions[]` |
| `space_nat_info` | `GET /spaces/{id_or_name}/nat` | `space` |
| `space_topology` | `GET /spaces/{id_or_name}/topology` | `space` |
| `peerings_list` 📄 | `GET /spaces/{id_or_name}/peerings` | `space` |
| `peerings_info` | `GET /spaces/{id_or_name}/peerings/{id}` | `space`, `peering` |
| `peerings_create` 🧪 | `POST /spaces/{id_or_name}/peerings` | `space`, AWS account/VPC fields |
| `peerings_delete` ⚠ | `DELETE /spaces/{id_or_name}/peerings/{id}` | `space`, `peering`, `confirm: <id>` |
| `peering_info` | `GET /spaces/{id_or_name}/peering-info` | `space` |
| `inbound_ruleset_current` | `GET /spaces/{id_or_name}/inbound-ruleset` | `space` |
| `inbound_rulesets_list` 📄 | `GET /spaces/{id_or_name}/inbound-rulesets` | `space` |
| `inbound_rulesets_info` | `GET /spaces/{id_or_name}/inbound-rulesets/{id}` | `space`, `ruleset` |
| `inbound_rulesets_create` 🧪 | `PUT /spaces/{id_or_name}/inbound-ruleset` | `space`, `rules: [{action, source}]` |
| `vpn_connections_list` 📄 | `GET /spaces/{id_or_name}/vpn-connections` | `space` |
| `vpn_connections_info` | `GET /spaces/{id_or_name}/vpn-connections/{id}` | `space`, `vpn` |
| `vpn_connections_create` 🧪 | `POST /spaces/{id_or_name}/vpn-connections` | `space`, `name`, `public_ip`, `routable_cidrs[]` |
| `vpn_connections_delete` ⚠ | `DELETE /spaces/{id_or_name}/vpn-connections/{id}` | `space`, `vpn`, `confirm: <name>` |
| `space_transfer_create` ⚠🧪 | `POST /spaces/{id_or_name}/transfer` | `space`, `new_owner`, `confirm: <name>` |

## Tier: `addons_consumer`

> The `allowed_addon_services_*` tools formerly listed here ship with the `teams` tier in Phase 2b (they target `/teams/{id_or_name}/allowed-addon-services`). See the teams tier table.

| Tool | Wraps | Params |
|---|---|---|
| `addon_services_list` 📄 | `GET /addon-services` | — |
| `addon_services_info` | `GET /addon-services/{id_or_name}` | `service` |
| `region_capabilities_list` 📄 | `GET /addon-services/{id_or_name}/region-capabilities` | `service` |
| `plans_list` 📄 | `GET /addon-services/{id_or_name}/plans` | `service` |
| `plans_info` | `GET /addon-services/{id_or_name}/plans/{id_or_name}` | `service`, `plan` |
| `addons_list` 📄 | `GET /addons` | — |
| `addons_info` | `GET /addons/{id_or_name}` | `addon` |
| `addons_list_by_app` 📄 | `GET /apps/{id_or_name}/addons` | `app` |
| `addons_list_by_user` 📄 | `GET /users/~/addons` | — |
| `addons_resolve` | `POST /actions/addons/resolve` | `addon`, `app?`, `addon_service?` |
| `addons_create` 🧪 | `POST /apps/{id_or_name}/addons` | `app`, `plan`, `name?`, `attachment?`, `config?`, `confirm?` |
| `addons_update` 🧪 | `PATCH /apps/{id_or_name}/addons/{id_or_name}` | `app`, `addon`, `plan` |
| `addons_delete` ⚠ | `DELETE /apps/{id_or_name}/addons/{id_or_name}` | `app`, `addon`, `confirm: <name>` |
| `addon_attachments_list` 📄 | `GET /addon-attachments` | — |
| `addon_attachments_list_by_app` 📄 | `GET /apps/{id_or_name}/addon-attachments` | `app` |
| `addon_attachments_list_by_addon` 📄 | `GET /addons/{id_or_name}/addon-attachments` | `addon` |
| `addon_attachments_info` | `GET /addon-attachments/{id}` | `attachment` |
| `addon_attachments_create` 🧪 | `POST /addon-attachments` | `addon`, `app`, `name?`, `namespace?` |
| `addon_attachments_delete` ⚠ | `DELETE /addon-attachments/{id}` | `attachment`, `confirm: <name>` |
| `addon_webhooks_list` 📄 | `GET /addons/{id_or_name}/webhooks` | `addon` |
| `addon_webhooks_info` | `GET /addons/{id_or_name}/webhooks/{id}` | `addon`, `webhook` |
| `addon_webhooks_create` 🧪 | `POST /addons/{id_or_name}/webhooks` | `addon`, `url`, `include`, `level`, `secret?` |
| `addon_webhooks_update` 🧪 | `PATCH /addons/{id_or_name}/webhooks/{id}` | `addon`, `webhook`, fields |
| `addon_webhooks_delete` ⚠ | `DELETE /addons/{id_or_name}/webhooks/{id}` | `addon`, `webhook`, `confirm: <addon>` |
| `addon_webhook_deliveries_list` 📄 | `GET /addons/{id_or_name}/webhook-deliveries` | `addon` |
| `addon_webhook_events_list` 📄 | `GET /addons/{id_or_name}/webhook-events` | `addon` |
| `addon_config_get` | `GET /addons/{id_or_name}/config` | `addon` |

## Tier: `pipelines`

| Tool | Wraps | Params |
|---|---|---|
| `pipelines_list` 📄 | `GET /pipelines` | — |
| `pipelines_info` | `GET /pipelines/{id_or_name}` | `pipeline` |
| `pipelines_create` 🧪 | `POST /pipelines` | `name`, `owner?` |
| `pipelines_update` 🧪 | `PATCH /pipelines/{id_or_name}` | `pipeline`, fields |
| `pipelines_delete` ⚠ | `DELETE /pipelines/{id_or_name}` | `pipeline`, `confirm: <name>` |
| `pipeline_couplings_list` 📄 | `GET /pipeline-couplings` | — |
| `pipeline_couplings_list_by_pipeline` 📄 | `GET /pipelines/{id}/pipeline-couplings` | `pipeline` |
| `pipeline_couplings_info` | `GET /pipeline-couplings/{id}` | `coupling` |
| `pipeline_couplings_info_by_app` | `GET /apps/{id_or_name}/pipeline-couplings` | `app` |
| `pipeline_couplings_create` 🧪 | `POST /pipeline-couplings` | `app`, `pipeline`, `stage` |
| `pipeline_couplings_update` 🧪 | `PATCH /pipeline-couplings/{id}` | `coupling`, `stage` |
| `pipeline_couplings_delete` ⚠ | `DELETE /pipeline-couplings/{id}` | `coupling`, `confirm: <id>` |
| `pipeline_builds_list` 📄 | `GET /pipelines/{id}/latest-builds` | `pipeline` |
| `pipeline_config_vars_get` | `GET /pipelines/{id_or_name}/stage/{stage}/config-vars` | `pipeline`, `stage` |
| `pipeline_config_vars_update` 🧪 | `PATCH /pipelines/{id_or_name}/stage/{stage}/config-vars` | `pipeline`, `stage`, `config` |
| `pipeline_deployments_list` 📄 | `GET /pipelines/{id}/latest-deployments` | `pipeline` |
| `pipeline_promotions_list` 📄 | `GET /pipeline-promotions` | — |
| `pipeline_promotions_info` | `GET /pipeline-promotions/{id}` | `promotion` |
| `pipeline_promotions_create` 🧪 | `POST /pipeline-promotions` | `pipeline`, `source`, `targets[]` |
| `pipeline_promotion_targets_list` 📄 | `GET /pipeline-promotions/{id}/promotion-targets` | `promotion` |
| `pipeline_releases_list` 📄 | `GET /pipelines/{id}/latest-releases` | `pipeline` |
| `pipeline_stacks_list` 📄 | `GET /pipeline-stack-config` | — |
| `pipeline_transfers_create` ⚠🧪 | `POST /pipeline-transfers` | `pipeline`, `new_owner`, `confirm: <name>` |

## Tier: `data` (host: `api.data.heroku.com`)

### Postgres

| Tool | Wraps | Params |
|---|---|---|
| `postgres_info` | `GET /client/v11/databases/{addon}` | `addon` |
| `postgres_credentials_list` 📄 | `GET /postgres/v0/databases/{addon}/credentials` | `addon` |
| `postgres_credentials_info` | `GET /postgres/v0/databases/{addon}/credentials/{name}` | `addon`, `name` |
| `postgres_credentials_create` 🧪 | `POST /postgres/v0/databases/{addon}/credentials` | `addon`, `name` |
| `postgres_credentials_rotate` ⚠ | `POST /postgres/v0/databases/{addon}/credentials/{name}/credentials_rotation` | `addon`, `name`, `confirm: <name>` |
| `postgres_credentials_destroy` ⚠ | `DELETE /postgres/v0/databases/{addon}/credentials/{name}` | `addon`, `name`, `confirm: <name>` |
| `postgres_backups_list` 📄 | `GET /client/v11/apps/{app}/transfers` | `app` |
| `postgres_backup_capture` 🧪 | `POST /client/v11/apps/{app}/transfers` | `app`, source params |
| `postgres_backup_schedule_list` 📄 | `GET /client/v11/databases/{addon}/transfer-schedules` | `addon` |

### Heroku Key-Value Store (Redis)

| Tool | Wraps | Params |
|---|---|---|
| `redis_info` | `GET /redis/v0/databases/{addon}` | `addon` |
| `redis_credentials_reset` ⚠ | `POST /redis/v0/databases/{addon}/credentials_rotation` | `addon`, `confirm: <addon>` |
| `redis_maintenance_window_get` | `GET /redis/v0/databases/{addon}/maintenance-window` | `addon` |
| `redis_maintenance_window_set` 🧪 | `PUT /redis/v0/databases/{addon}/maintenance-window` | `addon`, `description` |

### Apache Kafka

| Tool | Wraps | Params |
|---|---|---|
| `kafka_info` | `GET /data/kafka/v0/clusters/{addon}` | `addon` |
| `kafka_topics_list` 📄 | `GET /data/kafka/v0/clusters/{addon}/topics` | `addon` |
| `kafka_topics_info` | `GET /data/kafka/v0/clusters/{addon}/topics/{name}` | `addon`, `name` |
| `kafka_topics_create` 🧪 | `POST /data/kafka/v0/clusters/{addon}/topics` | `addon`, topic config |
| `kafka_topics_delete` ⚠ | `DELETE /data/kafka/v0/clusters/{addon}/topics/{name}` | `addon`, `name`, `confirm: <name>` |
| `kafka_consumer_groups_list` 📄 | `GET /data/kafka/v0/clusters/{addon}/consumer-groups` | `addon` |

> Data API paths above reflect documented patterns but vary by add-on plan and generation. The implementation must read the live API rather than treating these paths as canonical. If a path 404s, the tool returns a typed error pointing the user to `heroku addons:open <addon>` for current API discovery.

---

# `heroku-partner-mcp`

## Diagnostic — always on

| Tool | Wraps | Params |
|---|---|---|
| `whoami_partner` | (composite) | — | Returns configured client_id, known resource UUIDs, manifest-auth presence. |
| `refresh_capabilities` | (none) | `force?` | Re-probes each token. |
| `audit_tail` | (local) | `limit?` | |
| `manifest_validate` | (local) | `manifest: object` | Lints against the Add-on Manifest schema. |
| `manifest_generate` | (local) | `name`, `category?`, `plans?` | Produces a starter manifest. |

## OAuth lifecycle

| Tool | Wraps | Params |
|---|---|---|
| `grant_exchange` 🧪 | `POST https://id.heroku.com/oauth/token` | `code: string`, `client_secret?` (defaults to configured), `resource_uuid: string` → stores tokens encrypted, returns expiry only |
| `token_refresh` 🧪 | `POST https://id.heroku.com/oauth/token` | `resource_uuid: string` → re-uses stored refresh token, persists new access token |
| `token_revoke` ⚠ | (local invalidation only — Heroku has no revoke endpoint for partner tokens) | `resource_uuid`, `confirm: <uuid>` |
| `vendor_oauth_grant_get` 🧪 | `GET https://api.heroku.com/vendor/resources/{uuid}/oauth-grant` (manifest Basic auth) | `resource_uuid: string` — returns 403 + helpful message if Heroku hasn't enabled this flag for the partner |
| `tokens_list` | (local store) | — | Lists known `(resource_uuid, expires_at)` pairs; never returns the token itself. |

## Add-on lifecycle (Platform API, OAuth-scoped)

| Tool | Wraps | Params |
|---|---|---|
| `mark_provisioned` 🧪 | `POST /addons/{resource_uuid}/actions/provision` | `resource_uuid` |
| `mark_deprovisioned` 🧪 | `POST /addons/{resource_uuid}/actions/deprovision` | `resource_uuid` |

## Add-on inspection (Partner subset of Platform API)

All accept `resource_uuid: string` to select the OAuth token, plus any documented endpoint params. Tools 403 cleanly if the partner doesn't have access.

| Tool | Wraps |
|---|---|
| `addon_info` | `GET /addons/{resource_uuid}` |
| `addon_list_for_partner` 📄 | `GET /addons` (returns only same-service add-ons per Partner docs) |
| `addon_list_by_user` 📄 | `GET /users/{email_or_id}/addons` |
| `addon_list_by_app` 📄 | `GET /apps/{id_or_name}/addons` |
| `addon_attachments_list_by_addon` 📄 | `GET /addons/{resource_uuid}/addon-attachments` |
| `addon_attachments_list_by_app` 📄 | `GET /apps/{id_or_name}/addon-attachments` |
| `addon_attachments_info_by_app` | `GET /apps/{id_or_name}/addon-attachments/{name_or_id}` |
| `addon_config_get` | `GET /addons/{resource_uuid}/config` |
| `addon_config_update` 🧪 | `PATCH /addons/{resource_uuid}/config` |
| `app_info` | `GET /apps/{id_or_name}` |
| `app_list_via_partner` 📄 | `GET /apps` (returns only attached apps per Partner docs) |
| `app_collaborators_list` 📄 | `GET /apps/{id_or_name}/collaborators` |
| `app_domains_list` 📄 | `GET /apps/{id_or_name}/domains` |
| `apps_filter` | `POST /filters/apps` |
| `log_drains_list` 📄 | `GET /addons/{resource_uuid}/log-drains` |
| `log_drains_update` 🧪 | `PUT /addons/{resource_uuid}/log-drains/{id_or_url_or_token}` |
| `log_drains_create` 🧪 | `POST /apps/{id_or_name}/log-drains` |
| `log_drains_delete` ⚠ | `DELETE /apps/{id_or_name}/log-drains/{id_or_url_or_token}` |
| `pipeline_info` | `GET /pipelines/{id_or_name}` |
| `pipelines_list` 📄 | `GET /pipelines` |
| `pipeline_couplings_list` 📄 | `GET /pipeline-couplings` |
| `pipeline_couplings_list_by_pipeline` 📄 | `GET /pipelines/{id}/pipeline-couplings` |
| `pipeline_couplings_info` | `GET /pipeline-couplings/{id}` |
| `pipeline_couplings_info_by_app` | `GET /apps/{id_or_name}/pipeline-couplings` |
| `team_members_list` 📄 | `GET /teams/{id_or_name}/members` |

## Add-on installs (manifest auth, not OAuth)

| Tool | Wraps | Params |
|---|---|---|
| `installs_list` 📄 | `GET https://addons.heroku.com/api/v3/apps` (Basic auth) | optional filters per addons.heroku.com docs |

## Webhook validators — local, no Heroku calls

Each accepts a raw HTTP request (method, path, headers, body as string) and returns a parsed, validated payload plus a verdict.

| Tool | Validates |
|---|---|
| `webhook_provision_validate` | Inbound `POST /heroku/resources` from Heroku |
| `webhook_plan_change_validate` | Inbound `PUT /heroku/resources/:uuid` |
| `webhook_deprovision_validate` | Inbound `DELETE /heroku/resources/:uuid` |
| `webhook_sso_validate` | Inbound `POST /heroku/sso` form-encoded request |
| `webhook_basic_auth_verify` | Checks `Authorization: Basic …` against configured manifest id + api password |

Returns:
```ts
{
  valid: boolean,
  reason?: string,                // e.g. "auth_mismatch", "bad_body", "expired_grant"
  parsed?: { ...payload },
  idempotencyKey?: string,        // the uuid; partner should dedupe on this
}
```
