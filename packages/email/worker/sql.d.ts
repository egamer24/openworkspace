/**
 * SQL files imported as text: drizzle-kit's drizzle/mailbox/migrations.js
 * imports each mailbox migration, and Alchemy's bundler loads `.sql` as text.
 */
declare module "*.sql" {
  const sql: string;
  export default sql;
}
