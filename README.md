# Prisma & MySQL: A Practical Guide to Spatial Type Support

## The Problem: Natively Unsupported `SPATIAL` Indexes

**Note:** I fight with that for 3 days. I dont find any solution on the internet, so I write this article to help you. If you find it useful, please give me a star. I know meaby its skill issue, but I think this is a problem of Prisma and MySQL, not me. I hope this will help you to solve your problem with Unsupported | Spatial types in Prisma and MySQL.

In modern web applications, performing efficient geospatial queries (e.g., "find all posts within a 10km radius") is a common requirement. While MySQL 8.0+ offers robust support for spatial data types (`POINT`, `POLYGON`, etc.) and high-performance `SPATIAL` indexes, Prisma's support for this functionality in conjunction with MySQL is currently limited.

The core issue is that `prisma migrate dev`, the standard tool for evolving the database schema, does not fully understand spatial types or indexes. This leads to a critical conflict:
1.  We need a `SPATIAL INDEX` on a `GEOMETRY` or `POINT` column for performant queries.
2.  Any manual addition of this index via custom SQL in a migration file is actively "reverted" or "undone" by `prisma migrate dev` in subsequent migrations, as it attempts to synchronize the database state with the `schema.prisma` file, which lacks native syntax for these features.

This document outlines a battle-tested workflow to overcome this limitation, achieve massive performance gains, and maintain a manageable development process. Prisma after 5 years still doesn't support this. They have a 
[GitHub issue](https://github.com/prisma/prisma/issues/1798) open for this, but it seems to be stalled.
If they won't fix it, why they just dont add something to prevent `prisma migrate dev` from deleting our custom indexes and foreign keys? I don't know, but we need to do it ourselves.


## The Journey: A Tale of Performance Benchmarking

My initial goal was to compare two approaches for location-based searches on a dataset of 100,000+ posts:

1.  **"Bounding Box" Method:** A naive approach using two standard `float` columns (`latitude`, `longitude`) with `BTREE` indexes. The query filters results within a square-shaped area.
2.  **`SPATIAL INDEX` Method:** The "correct" architectural approach using a native `POINT` column with a `SPATIAL` index and Raw SQL queries for geospatial operations.

### Initial (Misleading) Results

At a small scale (5,000 records), the simple "Bounding Box" method was surprisingly faster. However, as we scaled the data to 100,000 records, the truth emerged. The most significant discovery was the **catastrophic performance impact of `ORDER BY`** when combined with spatial queries.

| Scenario (100,000 records, 1000 runs) | `Bounding Box` | `SPATIAL` (with `ORDER BY`) | `SPATIAL` (**without** `ORDER BY`) |
| :--- | :--- | :--- | :--- |
| **Average Query Time** | ~448 ms | ~95 ms | **~4.5 ms** |

**Conclusion:** The `SPATIAL INDEX` provides a **~100x performance increase**, but only when the query plan is not compromised by a `ORDER BY` clause.

## The Solution: A Custom Migration Workflow

### 1. Schema Definition (`schema.prisma`)

We isolate the unsupported spatial data into a dedicated `PostCoordinates` model. Crucially, we use  `@ignore` on the relation in the `Post` model. This tells Prisma to be completely unaware of this table's existence, preventing it from ever trying to manage it.

**Disclaimer:** For the Unspported type, you should use the other model, because when you use it in the Main model, it will prevent you to use .create() or .createMany() on it. When you use it in the other model, you can use .create() or .createMany() on main model, and use raw SQL queries to insert data into the `PostCoordinates` model.

```prisma
// in schema.prisma

model Post {
  id        Int      @id @default(autoincrement())
  // ... other Post fields
  
  // This relation is IGNORED by Prisma Client and Migrate.
  // It serves only as a mental note for developers.
  coordinates PostCoordinates? @ignore
}

/// This model holds our spatial data.
/// It is completely ignored by Prisma, so we must manage it manually.
model PostCoordinates {
  id      Int      @id @default(autoincrement())
  post    Post     @relation(fields: [postId], references: [id], onDelete: Cascade)
  postId  Int      @unique
  
  // The 'Unsupported' type is a placeholder. The true schema is defined in a manual migration.
  geo     Unsupported("POINT NOT NULL SRID 4326")
}
```

### 2. Manual Migration

Because in the `PostCoordinates` model we can't set relations, we must create and manage its table and indexes entirely through a manual migration. We create a migration file and fill it with our own hand-crafted, correct SQL.

**Command to Create Setup Migration:**
```bash
npx prisma migrate dev --name "init_post_coordinates" --create-only
```

This command generates a migration file in the `prisma/migrations` directory, which we then edit to include our custom SQL for creating the `PostCoordinates` table and adding the necessary spatial index.

**Example Migration (`...init_post_coordinates/migration.sql`):**
```sql
-- Add Foreign Key
ALTER TABLE `PostCoordinates` ADD CONSTRAINT `PostCoordinates_postId_fkey` FOREIGN KEY (`postId`) REFERENCES `Post`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Add Spatial Index
CREATE SPATIAL INDEX `idx_postcoordinates_geo` ON `PostCoordinates`(`geo`);
```

**Now Migrate the database:**
```bash
npx prisma migrate deploy
```

This command applies the migration, creating the `PostCoordinates` table with the `POINT` column and the `SPATIAL INDEX`.

### 3. The `migrate:safe` Workflow

The core problem remains: how do we create *new* migrations for other models (e.g., `User`, `Post`) without `prisma migrate dev` trying to drop our manually created indexes and foreign keys?

**Lets replace `prisma migrate dev` with a custom script.**

This script, `migrate-safe.ts`, automates the process of "supervised migration".

**First, we need to get the SQL queries, that prisma use to delete our custom setup in npx prisma migrate dev**

```bash
npx prisma migrate dev --create-only
```
This command generates a new migration file, which we will then process to remove any unwanted `DROP INDEX` or `DROP FOREIGN KEY` statements that target our `PostCoordinates` table where you can find them. **For your safety, please copy this lines to the `linesToRemove` array in the script `migrate-safe.ts` and remove them manually from migration.sql.**
Then run last time `npx prisma migrate deploy` to apply the migration.

After that, we can run the script to safely apply migrations without losing our custom spatial setup.

**The process is as follows:**
1.  It runs `prisma migrate dev --create-only` to generate a new migration file based on schema changes.
2.  It reads this newly generated `migration.sql` file.
3.  It **automatically removes** any dangerous, auto-generated `DROP INDEX` or `DROP FOREIGN KEY` statements that target our `PostCoordinates` table.
4.  It saves the "cleaned" migration file.
5.  Finally, it runs `prisma migrate deploy` to safely apply all pending (and now clean) migrations.

This provides a safe, repeatable, and automated way to evolve the schema without a developer needing to manually edit every migration file.

### 4. Implementation Details

#### The `migrate:safe` Script

```typescript
// File: migrate-safe.ts
// NOTE: This version is a conceptual representation. The final working script from is in repo but **You should use it as a reference**.
// It handles mixed module types (require/import) and robustly finds/edits the migration file.

// We use require for built-in Node.js modules for compatibility
const { execSync } = require('child_process');
import fs from 'fs';
import path from 'path';

// --- Configuration: Lines to remove from auto-generated migrations ---
// --- If you need to add more lines, just append them to this array. ---
// --- Remember! If you use this code with other models, ensure the lines are relevant to those models. ---
// --- You can check what lines are generated by `prisma migrate dev --create-only` and add them here. ---

const linesToRemove = [
  'ALTER TABLE `PostCoordinates` DROP FOREIGN KEY `PostCoordinates_postId_fkey`;',
  'DROP INDEX `idx_postcoordinates_geo` ON `PostCoordinates`;',
];
// --------------------

function runCommand(command: string) {
  // ... implementation to run a shell command
}

async function main() {
  const migrationName = process.argv[2]; 
  if (!migrationName) {
    console.error(`Error: Provide migration name.`);
    process.exit(1);
  }

  // Step 1: Generate migration file
  runCommand(`npx prisma migrate dev --name "${migrationName}" --create-only`);

  // Step 2: Find the latest migration file
  // ... logic to find the correct `migration.sql` file ...

  // Step 3: Read, clean, and save the file
  // ... logic to read the file, filter out `linesToRemove`, and write it back ...

  // Step 4: Apply migrations safely
  runCommand('npx prisma migrate deploy');

  console.info(`\n🎉 Safe migration completed successfully!`);
}

main();
```

#### `package.json` Configuration

To handle the mixed CommonJS/ESM module issues inherent in a modern Node.js project with `ts-node`, we use a specific `compiler-options` flag.

```json
{
  "scripts": {
    "migrate:safe": "ts-node --compiler-options \"{\\\"module\\\":\\\"CommonJS\\\"}\" migrate-safe.ts"
  }
}
```

This command ensures that `ts-node` can correctly process our script, which may use `import` statements for packages like `chalk` while the rest of the project is configured differently.

## Final Conclusion

By  replacing the standard `prisma migrate dev` command with a custom, supervised script, we can successfully leverage the power of MySQL's `SPATIAL` indexes within a Prisma project. This approach provides a solution, turning a major limitation of the tool into a manageable engineering workflow.


## Contribution

Contributions to this document are welcome! If you have suggestions, improvements, or corrections, please feel free to submit a pull request or open an issue. Let's fix this together if prisma team doesn't do it after 5 years.

## Author

TheLoloS
