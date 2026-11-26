# TikTok and LinkedIn

Social posts straight to TikTok and LinkedIn through our own apps with each
network, beside Facebook and Instagram. Nothing goes through a third-party
scheduler. This page says how it works, how to set up each developer app,
which settings go where, and — at the end — everything that was written from
memory and must be checked against each network's own documentation before
going live.

## How it works

- **Connections.** Each network is one connection per workspace (provider
  `tiktok` / `linkedin`), offered on the Connections page and in Settings →
  Social accounts only where its app's keys are set. A connection holds
  **several logins**: one per TikTok account, and one per LinkedIn person.
  Each login's tokens sit inside the connection's one Vault secret under
  `login:<id>` (`src/lib/connections/logins.ts`), read only through
  `getProviderToken` and renewed one login at a time under the connection's
  refresh lock. A login whose access ran out is marked on its accounts
  ("Needs connecting again"); the others carry on. Connecting again adds a
  login, or renews the one you sign in as.
- **Accounts.** A TikTok account, a LinkedIn company page and a LinkedIn
  person are `social_accounts` rows (`network` `tiktok` / `linkedin`,
  `login_id` saying which login posts as them). Owners and admins choose
  which are used and their brand under Settings → Social accounts, within
  the plan's `social_accounts` limit per network. "Disconnect" on one login
  stops only its accounts.
- **Rules.** Every network's rules (caption length, hashtags, how many
  photos, video or not) are one table: `PLACE_RULES` in
  `src/lib/social/networks.ts`, the same as `private.social_place_rule` in
  the database (a test keeps them equal). The composer checks them before a
  post is scheduled; the database checks them again whenever a post becomes
  scheduled.
- **TikTok's own choices.** TikTok asks apps to let the person choose, for
  every post: who can see it (only from the list TikTok gives for that
  account, with nothing chosen for them), whether comments, duets and
  stitches are allowed (all off until switched on; off for good where the
  creator switched them off in TikTok), and whether it promotes their own
  brand or is branded content (which can't be private). These are
  `social_posts.target_options`, per TikTok account, checked by Zod
  (`src/lib/social/tiktok-options.ts`) and by the database. The composer
  asks TikTok ("creator info") each time a TikTok account is shown.
- **Sending once.** The worker sends each account's part on its own. Just
  before the one write that publishes, it marks the target `sending`
  (`begin_social_target`). A video still being prepared is `pending`: it is
  asked about every ten minutes, never sent again, and doesn't use up a try.
  A lost answer is `unsure`: nothing sends it again by itself; the post page
  asks a person to look on the network and say whether it's there
  (`settle_social_target`). None of these can be wiped by a save, a retry or
  a delete. A worker still on the earlier code never claims a post with
  TikTok or LinkedIn in it.
- **Media.** Only from our own `social` bucket. The worker reads the file
  from our storage and sends it to the network as a file; no address a
  person typed is ever fetched.

### TikTok specifics

- **Videos only, for now.** A TikTok post needs one video. TikTok takes a
  video either as a file we send (`FILE_UPLOAD`) or by fetching it from a
  web address (`PULL_FROM_URL`). Fetching needs TikTok to have verified that
  the address is ours, and our files sit on Supabase's storage host, which
  we can't put a DNS record on. So videos go as files, which needs no
  verification. TikTok's **photo posts** can only be fetched from a verified
  address; they are not built. To add them later: verify a URL prefix of
  the public bucket (`https://<project>.supabase.co/storage/v1/object/public/social/`)
  with TikTok's URL-prefix verification (a file TikTok gives you, placed at
  that prefix), or serve the files from a domain of ours and verify that;
  then add the photo route and change the `tiktok` row of the rules table.
- **Before TikTok's review.** An app TikTok hasn't audited can only post
  videos that only the creator can see (`SELF_ONLY`), and only for a small
  number of accounts a day. Until `TIKTOK_APP_AUDITED=true` is set, the
  composer offers only "Only you", says why in plain words, and the
  Connections page says so too. A person can make each video public in the
  TikTok app afterwards.
- **Length.** We can't read a video's length on the server (no video
  library). TikTok refuses one longer than the account's limit, and the post
  page shows TikTok's reason.

### LinkedIn specifics

- **As a company page, or as the person.** Signing in offers the person's
  own profile (with `w_member_social`) and, where the app has LinkedIn's
  Community Management API, every company page they administer (role
  `ADMINISTRATOR` or `CONTENT_ADMINISTRATOR`). Company-page posting is asked
  for only where `LINKEDIN_COMPANY_PAGES=true`: asking for a permission the
  app doesn't have makes LinkedIn refuse the whole sign-in.
- **Posts.** Words alone, one or several photos (several become one
  multi-image post), or one video. LinkedIn reads some characters as markup,
  so the words are escaped (`littleText`): hashtags go as plain words, not
  links.
- **Access runs out.** LinkedIn's access lasts about 60 days. Only apps
  LinkedIn approves for it get refresh tokens; without one, the login must
  be connected again when it runs out. The Connections page warns two weeks
  before, and Settings → Social accounts shows the date.

## Setting up the TikTok app

Do this once per deployment (staging and production can share one app with
both redirect addresses, or have one each). A browser assistant can follow
these steps.

1. Go to <https://developers.tiktok.com/> and sign in with the business's
   TikTok developer account (create one if asked; it can be an organisation).
2. **Manage apps → Connect an app** (or "Create app"). Name it after the
   suite, choose the category that fits (e.g. "Business tools"), and give a
   short description: "Schedules and publishes the business's own videos to
   its TikTok accounts."
3. **Platform: Web.** Fill in:
   - Website / Web URL: the suite's address (staging
     `https://web-staging-11af7da6.up.railway.app`; production
     `https://<production domain>`).
   - Terms of Service URL: `<site>/terms`. Privacy Policy URL:
     `<site>/privacy`.
   - TikTok may ask you to **verify the domain** of these addresses: choose
     the domain, copy the TXT record TikTok shows into the domain's DNS, and
     press Verify. (Railway's `*.up.railway.app` staging domain can't take a
     TXT record; use a domain of ours for anything TikTok must verify.)
4. **Add products:** **Login Kit** and **Content Posting API**.
5. **Login Kit → Redirect URI**, add each:
   - `https://web-staging-11af7da6.up.railway.app/api/connections/tiktok/callback`
   - `https://<production domain>/api/connections/tiktok/callback`
6. **Content Posting API:** switch on **Direct Post**. You do not need
   "Upload to inbox". You do not need URL ownership verification for videos
   (we send the file); you would for photo posts (see above).
7. **Scopes:** add `user.info.basic` and `video.publish`.
8. Copy the **Client key** and **Client secret** (shown on the app's page)
   into the Railway variables below. Never paste them into a chat.
9. **Sandbox / before review:** while the app is in development, add the
   TikTok accounts that will test it as target users if TikTok asks. Posts
   go up as "Only you".
10. **Submit for review** when ready. TikTok asks for: what the app does,
    each scope and why (`user.info.basic`: show which account is connected;
    `video.publish`: publish the business's own videos when a person
    schedules them), and a **screen recording** of the whole flow on the
    domain you registered: connecting a TikTok account, the composer with
    TikTok ticked (the creator's name shown, "Who can see it" with no choice
    made, comments/duet/stitch off, the brand-disclosure switch, the Music
    Usage Confirmation words), scheduling, and the video arriving on TikTok.
    Once TikTok approves (it says the app is "audited" for direct post), set
    `TIKTOK_APP_AUDITED=true`.

## Setting up the LinkedIn app

1. Go to <https://www.linkedin.com/developers/apps> and **Create app**. It
   must be linked to a LinkedIn **company page** of the business (LinkedIn
   asks for it, and an admin of that page must verify the app: **Settings →
   Verify**, send the link to the page admin, who approves it).
2. Fill in the app name, privacy policy URL (`<site>/privacy`) and logo.
3. **Products:** request **Sign In with LinkedIn using OpenID Connect** and
   **Share on LinkedIn**. Both are usually granted at once. They give
   `openid`, `profile` and `w_member_social`: posting as the person.
4. **For company pages:** request the **Community Management API**. This
   needs LinkedIn's review (a form about the business and how pages are
   used) and can take weeks. LinkedIn has asked that this product sit on an
   app of its own, without other products; if so, create a second app just
   for it and use its keys instead. Once approved it gives
   `w_organization_social` and `rw_organization_admin`; then set
   `LINKEDIN_COMPANY_PAGES=true`. Approved partners can also ask for
   refresh tokens ("programmatic refresh tokens"), which spare people
   connecting again every 60 days.
5. **Auth → Authorized redirect URLs**, add each:
   - `https://web-staging-11af7da6.up.railway.app/api/connections/linkedin/callback`
   - `https://<production domain>/api/connections/linkedin/callback`
6. Copy the **Client ID** and **Client Secret** (Auth tab) into the Railway
   variables below. Never paste them into a chat.
7. Check which **API version** (`LinkedIn-Version`, YYYYMM) is current on
   LinkedIn's versioning page and set `LINKEDIN_API_VERSION` to it; LinkedIn
   retires each version about a year after release.

## Settings (Railway variables, on BOTH `web` and `worker`)

Set them in Railway → the project → each service → Variables. Never commit
them or paste them into a chat. `.env.example` lists them for local use.

| Variable                 | What                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `TIKTOK_CLIENT_KEY`      | The TikTok app's client key. With the secret, TikTok is offered.                         |
| `TIKTOK_CLIENT_SECRET`   | The TikTok app's client secret.                                                          |
| `TIKTOK_APP_AUDITED`     | `true` once TikTok has audited the app for direct post. Until then, posts are private.   |
| `TIKTOK_PKCE_ENCODING`   | Optional. `base64url` if TikTok's sign-in refuses our PKCE challenge (default `hex`).    |
| `LINKEDIN_CLIENT_ID`     | The LinkedIn app's client id. With the secret, LinkedIn is offered.                      |
| `LINKEDIN_CLIENT_SECRET` | The LinkedIn app's client secret.                                                        |
| `LINKEDIN_COMPANY_PAGES` | `true` once the app has the Community Management API: sign-in then asks for page access. |
| `LINKEDIN_API_VERSION`   | Optional. The `LinkedIn-Version` to send, YYYYMM (default `202610`).                     |

## Written from memory, check before going live

The TikTok and LinkedIn documentation couldn't be reached while this was
built. Everything below was written from memory. Check each against the
network's current documentation, and correct the code (and this list) where
it differs. Each item names where it lives.

### TikTok (`src/lib/tiktok/client.ts`, `src/lib/connections/providers/tiktok.ts`, `src/lib/social/send/tiktok.ts`, `src/lib/social/tiktok-options.ts`)

- Authorize URL `https://www.tiktok.com/v2/auth/authorize/` with
  `client_key`, `response_type=code`, `scope` (comma separated),
  `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`.
- **PKCE encoding:** TikTok's pages have described the challenge as the
  SHA-256 of the verifier **in hex**, unlike the usual base64url. The code
  sends hex; `TIKTOK_PKCE_ENCODING=base64url` switches. Check which TikTok
  wants for a web app, and whether web apps need PKCE at all.
- Token: `POST https://open.tiktokapis.com/v2/oauth/token/` (form) with
  `client_key`, `client_secret`, `code`, `grant_type=authorization_code`,
  `redirect_uri`, `code_verifier`; answer `access_token`, `expires_in`
  (~86,400 s), `refresh_token`, `refresh_expires_in` (~1 year), `open_id`,
  `scope`. Renew with `grant_type=refresh_token`; TikTok may return a new
  refresh token. Errors as `{error, error_description}` (e.g.
  `invalid_grant`).
- Revoke: `POST https://open.tiktokapis.com/v2/oauth/revoke/` (form)
  `client_key`, `client_secret`, `token`.
- Scopes `user.info.basic` and `video.publish`; the `scope` answer lists
  what was granted.
- User: `GET https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username`
  → `data.user`. `username` may need `user.info.profile`; the code shows the
  display name when it's absent.
- API answers wrap `{data, error: {code, message, log_id}}`, with
  `error.code` `"ok"` on success. Codes used: `access_token_invalid`,
  `scope_not_authorized`, `rate_limit_exceeded`, `spam_risk_too_many_posts`,
  `spam_risk_user_banned_from_posting`,
  `unaudited_client_can_only_post_to_private_accounts`,
  `privacy_level_option_mismatch`.
- Creator info: `POST https://open.tiktokapis.com/v2/post/publish/creator_info/query/`
  → `privacy_level_options` (`PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`,
  `FOLLOWER_OF_CREATOR`, `SELF_ONLY`), `comment_disabled`, `duet_disabled`,
  `stitch_disabled`, `max_video_post_duration_sec`.
- Direct post: `POST https://open.tiktokapis.com/v2/post/publish/video/init/`
  with `post_info` {`title` (the caption, up to 2,200), `privacy_level`,
  `disable_comment`, `disable_duet`, `disable_stitch`,
  `brand_organic_toggle`, `brand_content_toggle`} and `source_info`
  {`source: "FILE_UPLOAD"`, `video_size`, `chunk_size`,
  `total_chunk_count`} → `data.publish_id`, `data.upload_url`.
- Chunks: a file up to 64 MB goes in one chunk (`chunk_size` = size);
  bigger ones in chunks of 5–64 MB with the remainder in the last. Upload is
  `PUT` to `upload_url` (on `*.tiktokapis.com`) with `Content-Type` and
  `Content-Range: bytes start-end/total`.
- Status: `POST https://open.tiktokapis.com/v2/post/publish/status/fetch/`
  `{publish_id}` → `status` (`PROCESSING_UPLOAD`, `PROCESSING_DOWNLOAD`,
  `SEND_TO_USER_INBOX`, `PUBLISH_COMPLETE`, `FAILED`), `fail_reason`,
  `publicaly_available_post_id` (spelled so; a list of large integers, kept
  as text).
- That nothing is published when a file upload never completes (so a failed
  upload can be started again safely).
- Unaudited apps: posts must be `SELF_ONLY`, and the number of accounts that
  can post per day is small; branded content can't be `SELF_ONLY`.
- The UX rules for apps (creator's name shown, no default privacy, toggles
  off by default and greyed where the creator disabled them, the
  commercial-disclosure switch and its "Your brand" / "Branded content"
  labels, the Music Usage Confirmation and Branded Content Policy words and
  their links in `composer.tsx`).
- Video limits the rules table assumes (`PLACE_RULES.tiktok`): caption
  2,200; one video; no photos via this route.

### LinkedIn (`src/lib/linkedin/client.ts`, `src/lib/connections/providers/linkedin.ts`, `src/lib/social/send/linkedin.ts`)

- Authorize `https://www.linkedin.com/oauth/v2/authorization` with
  `response_type=code`, `client_id`, `redirect_uri`, `state`, `scope`
  (space separated). Token `POST https://www.linkedin.com/oauth/v2/accessToken`
  (form, `client_id` and `client_secret` in the body) → `access_token`,
  `expires_in` (~5,184,000 s), and for approved apps `refresh_token`,
  `refresh_token_expires_in`; renew with `grant_type=refresh_token`.
  Revoke `POST https://www.linkedin.com/oauth/v2/revoke` with `token`.
- Scopes: `openid`, `profile`, `w_member_social`; for pages
  `w_organization_social` and `rw_organization_admin` (check whether
  listing a person's pages needs `rw_organization_admin` or
  `r_organization_admin`).
- Who: `GET https://api.linkedin.com/v2/userinfo` → `sub`, `name`. **Check
  that `sub` is the id used in `urn:li:person:{sub}`** as a post's author.
- Versioned calls under `https://api.linkedin.com/rest/` with headers
  `LinkedIn-Version: YYYYMM` and `X-Restli-Protocol-Version: 2.0.0`; the
  default version `202610` must be one LinkedIn still serves.
- Pages: `GET /rest/organizationAcls?q=roleAssignee&state=APPROVED&count=100`
  → `elements[]` {`organization` (URN), `role`, `state`}; posting roles
  taken as `ADMINISTRATOR` and `CONTENT_ADMINISTRATOR`. Names from
  `GET /rest/organizations/{id}` → `localizedName`.
- Images: `POST /rest/images?action=initializeUpload`
  `{initializeUploadRequest: {owner}}` → `value.uploadUrl`, `value.image`;
  `PUT` the bytes to `uploadUrl` (with the bearer token); status
  `GET /rest/images/{urn}` → `status` (`AVAILABLE`, …).
- Videos: `POST /rest/videos?action=initializeUpload`
  `{initializeUploadRequest: {owner, fileSizeBytes, uploadCaptions,
uploadThumbnail}}` → `value.video`, `value.uploadToken`,
  `value.uploadInstructions[]` {`uploadUrl`, `firstByte`, `lastByte`};
  `PUT` each part, keep each answer's `ETag`; `POST
/rest/videos?action=finalizeUpload` `{finalizeUploadRequest: {video,
uploadToken, uploadedPartIds}}`; status `GET /rest/videos/{urn}` →
  `status` (`PROCESSING`, `AVAILABLE`, `PROCESSING_FAILED`, …). Upload
  addresses taken to be on `*.linkedin.com` or `*.licdn.com`.
- Post: `POST /rest/posts` with `author`, `commentary`,
  `visibility: "PUBLIC"`, `distribution` {`feedDistribution: "MAIN_FEED"`,
  `targetEntities: []`, `thirdPartyDistributionChannels: []`},
  `lifecycleState: "PUBLISHED"`, `isReshareDisabledByAuthor: false`, and
  `content` {`media: {id}`} for one image or a video, or
  {`multiImage: {images: [{id}]}`} for several. Answer 201 with the post's
  URN in the `x-restli-id` header.
- Whether a video must be `AVAILABLE` before the post that names it is
  made (the code waits for it).
- Little-text escaping: the characters `\ | { } @ [ ] ( ) < > # * _ ~` are
  escaped with a backslash.
- Limits the rules table assumes (`PLACE_RULES.linkedin`): commentary up to
  3,000 characters (our boxes stop at 2,200); multi-image up to 20 (our
  posts stop at 10); one video.
- That access tokens last about 60 days and refresh tokens are only for
  approved apps; the 403 an un-approved page post gets.

### Shared

- Error statuses: a 5xx or a lost connection to the write that publishes
  is treated as "may have gone" (unsure); a 4xx as "certainly didn't".
