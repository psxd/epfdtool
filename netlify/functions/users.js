// Login accounts for the comment gate.
//
// This file is deliberately part of the (public) GitHub repo so accounts can be
// version-controlled next to the app — but it stores salted SHA-256 HASHES, not
// passwords, so reading the repo does not hand out the passwords.
//
// Add an account:
//   npm run add-user -- <username> "<password>" ["Display Name"]
//   npm run add-user -- <username> "<password>" "Name" --plain    (plain text)
//   npm run add-user -- <username> "<new password>" "Name" --force (overwrite)
// The script writes the entry below for you, then run:
//   npx netlify deploy --prod
// (a new deploy is required: Netlify functions only pick up env/file changes
// once they have been deployed).
//
// Two entry shapes are supported — hashed is preferred:
//   alice: { name: 'Alice', hash: '<salt>:<sha256-hex-of-"<salt>:<password>">' },
//   guest: { name: 'Guest', password: 'plain-text' },  // anyone reading the
//                                                      // repo can log in as this
//
// Netlify env vars can extend/override this list without touching the code:
//   COMMENT_USERS = {"bob":{"password":"hunter2","name":"Bob"},"carol":"pw"}
// and the single ADMIN_USERNAME/ADMIN_PASSWORD pair always stays valid too.
//
// Heads-up: Supabase's anon key is public in the browser (there is no other way
// to write comments) and `view_comments` accepts inserts with it, so this login
// is a UI-level gate for the comment tools, not a data-security boundary. Use
// real passwords anyway — and remember weak ones are crackable from a hash.
export const USERS = {
  espl: { name: "ESPL Admin", hash: '51663d7160acd0bc:3a9aa3c37f52541777ed62681fff07bdc31c666c30fb8cf71f5c2dbe0a9cd2ab' },
};
