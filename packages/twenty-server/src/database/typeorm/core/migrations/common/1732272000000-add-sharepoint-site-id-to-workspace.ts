import { type MigrationInterface, type QueryRunner } from 'typeorm';

export class AddSharePointSiteIdToWorkspace1732272000000
  implements MigrationInterface
{
  name = 'AddSharePointSiteIdToWorkspace1732272000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add sharepoint value to dataSource_type_enum
    await queryRunner.query(
      `ALTER TYPE "core"."dataSource_type_enum" ADD VALUE IF NOT EXISTS 'sharepoint'`,
    );

    // Add sharePointSiteId column to workspace table
    await queryRunner.query(
      `ALTER TABLE "core"."workspace" ADD "sharePointSiteId" varchar NULL`,
    );

    await queryRunner.query(
      `COMMENT ON COLUMN "core"."workspace"."sharePointSiteId" IS 'SharePoint site ID for workspaces using SharePoint as datasource. Populated during workspace initialization when WORKSPACE_DATASOURCE=sharepoint'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "core"."workspace" DROP COLUMN "sharePointSiteId"`,
    );

    // Note: PostgreSQL doesn't support removing enum values directly
    // The 'sharepoint' value will remain in the enum type
  }
}
