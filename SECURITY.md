# Security

Please report a vulnerability by email to security@c-f-x.com, not in a public issue.

Send what you found, how to reproduce it, and what an attacker could do with it. A proof of concept against your own deployment helps. Never test against someone else's deployment or read other people's mail.

Only the newest commit on `master` is supported. A fix lands there, and the report is credited in the commit unless you ask otherwise.

## What matters most

cf-mail holds other people's mail, so these come first:

- reading or changing a mailbox you were not given access to;
- signing in as someone else, or as an admin;
- getting a service key, a session or a secret out of a deployment;
- making a deployment send mail it should not send;
- running script in the web app through a received message.

How the app guards against these is in `docs/architecture.md`: the rules in section 2 and the security baseline in section 9.
