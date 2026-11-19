# CIRCArt sign-in emails

Supabase sends these emails; their text lives in the Supabase dashboard, not in code. To use these designs (with the 6-digit code the app asks for):

1. Supabase dashboard → the project → **Authentication → Emails → Templates**.
2. For each template below: set the **Subject**, then replace the whole **Message body** with the file's content (switch the editor to "Source"/HTML if it asks).

| Template in Supabase | File | Subject |
|---|---|---|
| Confirm signup | `confirm-signup.html` | `Dein CIRCArt-Code · Your CIRCArt code` |
| Magic Link | `magic-link.html` | `Dein CIRCArt-Code · Your CIRCArt code` |
| Change Email Address | `change-email.html` | `Bestätige deine E-Mail · Confirm your email` |

Notes
- `{{ .Token }}` is the 6-digit code, `{{ .ConfirmationURL }}` the link. Keep both: the code works on any device, the link only in the browser that asked for it.
- The logo is the app icon from the preview site. For the real game, change the image address to `https://YOUR-GAME-DOMAIN/icons/icon-192.png`.
- Emails are bilingual (German first) because Supabase sends one text to everyone.
- The "valid for one hour" line matches Supabase's default "Email OTP expiration" (3600 s, under Authentication → Providers → Email). Change the text if that setting changes.
- Supabase's built-in email service only sends a few emails per hour. A real email service (roadmap task 25) removes that limit.
