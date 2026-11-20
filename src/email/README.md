# CIRCArt sign-in emails

Supabase sends these emails; their HTML lives in the Supabase dashboard, not in the app code. All three templates are bilingual (German first) because Supabase sends one template per event to every player.

## Setup in Supabase

1. Open the target Supabase project (preview or production) → **Authentication → Sign In / Providers** and turn on **Anonymous sign-ins** and **Email**. Keep **Email OTP expiration** at `3600` seconds (1 hour) to match the template text.
2. Under **Authentication → URL Configuration**, set **Site URL** and **Redirect URLs**:
   - Preview: `https://nambatu.github.io/circart-preview/` and `https://nambatu.github.io/circart-preview/**`
   - Production: `https://YOUR-GAME-DOMAIN/` and `https://YOUR-GAME-DOMAIN/**`
3. Under **Authentication → Emails → Templates**, for each row below set the **Subject** and replace the entire **Message body** with the matching file (switch to the Source / HTML view):

| Template in Supabase | File | Subject |
|---|---|---|
| Confirm signup | `confirm-signup.html` | `Dein CIRCArt-Code · Your CIRCArt code` |
| Magic Link | `magic-link.html` | `Dein CIRCArt-Code · Your CIRCArt code` |
| Change Email Address | `change-email.html` | `Bestätige deine E-Mail · Confirm your email` |

## Important details

- **`{{ .Token }}` vs `{{ .ConfirmationURL }}`:** `{{ .Token }}` is the 6-digit OTP code the player types into the app (works across devices and browsers). `{{ .ConfirmationURL }}` is the magic link (only completes sign-in in the same browser session that requested it). Keep both placeholders in every template.
- **Logo URL:** the files in this folder point at the preview app icon (`https://nambatu.github.io/circart-preview/icons/icon-192.png`). When setting up the **production** Supabase project, replace that URL in all three templates with `https://YOUR-GAME-DOMAIN/icons/icon-192.png` before pasting.
- **Sender limits:** Supabase's built-in mailer only sends a few emails per hour. Before public launch, configure custom SMTP (roadmap task 25) and update section 7 (`[EMAIL PROVIDER]`) in the privacy pages (`src/legal/privacy-en.html` and `privacy-de.html`).
- Keep personal email addresses and secrets out of this folder and out of template examples.
