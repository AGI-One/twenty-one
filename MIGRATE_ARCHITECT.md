# SharePoint Migration Architecture - Self-Hosted Design

## Tổng Quan

Thiết kế đơn giản cho self-hosted deployment với SharePoint làm storage backend. Tất cả config qua environment variables, không có runtime detection phức tạp.

## Architecture Principles

### 1. ENV-Based Configuration (Self-Hosted Only)
```bash
# Datasource configuration
WORKSPACE_DATASOURCE=sharepoint          # hoặc 'postgres'
WORKSPACE_TENANT_ID=your-tenant-id       # Microsoft 365 Tenant ID

# File storage configuration
WORKSPACE_STORAGE_TYPE=sharepoint        # hoặc 's3' | 'local'
```

**Lý do**: Self-hosted → một tenant duy nhất → config toàn cục qua ENV là đủ.

### 2. Site & Lists Initialization Flow

Khi tạo workspace mới với `WORKSPACE_DATASOURCE=sharepoint`:

```
1. WorkspaceManagerService.init() được gọi
   ↓
2. Check env: WORKSPACE_DATASOURCE === 'sharepoint'?
   ↓ YES
3. Gọi SharePointService.getTwentySiteForTenant(tenantId, workspaceName)
   ↓
4. SharePointService tìm hoặc tạo site:
   - Search site "Twenty - {workspaceName}" qua Graph API
   - Nếu CHƯA TỒN TẠI: Tạo site mới
   - Nếu ĐÃ TỒN TẠI: Lấy siteId hiện có
   ↓
5. Lưu siteId vào workspace.sharePointSiteId trong core DB
   ↓
6. workspaceSyncMetadataService.synchronize() tạo ObjectMetadata trong core DB
   ↓
7. Gọi SharePointWorkspaceInitService.initializeWorkspace(tenantId, siteId, objectMetadataCollection)

   SharePointWorkspaceInitService thực hiện:
   - Phase 1: Loop qua tất cả ObjectMetadata
     * Gọi SharePointSchemaService.createListFromObjectMetadata()
     * Tạo SharePoint List với columns từ FieldMetadata
     * Lưu mapping objectName → listId

   - Phase 2: Setup relationships
     * Update Lookup columns với target listId
     * Configure foreign key relationships
   ↓
8. Tạo DataSourceMetadata với:
   - type: DataSourceTypeEnum.SHAREPOINT
   - schema: 'sharepoint' (placeholder)
   - workspaceId: workspace.id
```

### 3. Runtime Operation Flow

Khi workspace đã được tạo và user truy cập:

```
1. WorkspaceDatasourceFactory.createDatasource(workspaceId)
   ↓
2. Query workspace từ core DB → lấy workspace.sharePointSiteId
   ↓
3. Đọc WORKSPACE_TENANT_ID từ ENV
   ↓
4. Tạo SharePointWorkspaceDataSource với:
   - workspaceId
   - tenantId (from ENV)
   - siteId (from workspace.sharePointSiteId)
   ↓
5. Khi gọi datasource.getRepository(Entity):
   - SharePointRepository được tạo với tenantId + siteId đã có
   - Gọi Microsoft Graph API để CRUD data trên SharePoint Lists
   - Không cần resolve/detect gì thêm
```

## Database Schema Changes

### WorkspaceEntity (core.workspace table)

Thêm column mới:

```typescript
@Column({ type: 'varchar', nullable: true })
sharePointSiteId: string | null;
```

**Migration SQL:**
```sql
ALTER TABLE core.workspace
ADD COLUMN "sharePointSiteId" varchar NULL;

COMMENT ON COLUMN core.workspace."sharePointSiteId" IS
'SharePoint site ID for workspaces using SharePoint as datasource.
Populated during workspace initialization when WORKSPACE_DATASOURCE=sharepoint';
```

## Code Changes Required

### 1. WorkspaceEntity - Add sharePointSiteId Column

**File**: `/packages/twenty-server/src/engine/core-modules/workspace/workspace.entity.ts`

```typescript
@Column({ type: 'varchar', nullable: true })
sharePointSiteId: string | null;
```

**Migration**: Create migration file để add column vào core.workspace table.

### 2. WorkspaceManagerService.init() - SharePoint Branch

**File**: `/packages/twenty-server/src/engine/workspace-manager/workspace-manager.service.ts`

Thêm logic cho SharePoint:

```typescript
public async init({
  workspace,
  userId,
}: {
  workspace: WorkspaceEntity;
  userId: string;
}): Promise<void> {
  const workspaceId = workspace.id;

  // Determine datasource type from ENV
  const datasourceType = process.env.WORKSPACE_DATASOURCE === 'sharepoint'
    ? DataSourceTypeEnum.SHAREPOINT
    : DataSourceTypeEnum.POSTGRES;

  let schemaName: string;
  let siteId: string | undefined;

  if (datasourceType === DataSourceTypeEnum.SHAREPOINT) {
    // ====== SharePoint Initialization ======
    const tenantId = process.env.WORKSPACE_TENANT_ID;
    if (!tenantId) {
      throw new Error('WORKSPACE_TENANT_ID must be set when WORKSPACE_DATASOURCE=sharepoint');
    }

    // Initialize SharePoint site and get siteId
    siteId = await this.sharePointService.initializeWorkspaceSite(
      workspace.displayName || workspace.subdomain,
      tenantId,
    );

    // Save siteId to workspace
    await this.workspaceRepository.update(workspaceId, {
      sharePointSiteId: siteId,
    });

    // Use placeholder schema for SharePoint
    schemaName = 'sharepoint';

  } else {
    // ====== PostgreSQL Initialization ======
    schemaName = await this.workspaceDataSourceService.createWorkspaceDBSchema(
      workspaceId,
    );
  }

  // Create datasource metadata with type
  const dataSourceMetadata = await this.dataSourceService.createDataSourceMetadata(
    workspaceId,
    schemaName,
    datasourceType, // Pass the datasource type
  );

  // Continue with standard initialization...
  const featureFlags = await this.featureFlagService.getWorkspaceFeatureFlagsMap(workspaceId);

  await this.applicationService.createTwentyStandardApplication({ workspaceId });

  // Sync metadata (creates object metadata records in core DB)
  await this.workspaceSyncMetadataService.synchronize({
    workspaceId,
    dataSourceId: dataSourceMetadata.id,
    featureFlags,
  });

  await this.setupDefaultRoles(workspaceId, userId);

  // Prefill standard objects
  if (datasourceType === DataSourceTypeEnum.POSTGRES) {
    // For PostgreSQL: insert records into workspace schema
    await this.prefillWorkspaceWithStandardObjectsRecords(
      dataSourceMetadata,
      workspaceId,
      featureFlags,
    );
  } else {
    // For SharePoint: Lists already created, optionally insert seed data
    // await this.prefillSharePointWithStandardData(siteId, workspaceId);
  }
**File**: `/packages/twenty-server/src/engine/workspace-manager/workspace-manager.service.ts`

**Inject dependencies**:
```typescript
constructor(
  // ... existing dependencies
  private readonly sharePointService: SharePointService,
  private readonly sharePointWorkspaceInitService: SharePointWorkspaceInitService,
) {}
```

**Update init() method**:
```typescript
public async init({
  workspace,
  userId,
}: {
  workspace: WorkspaceEntity;
  userId: string;
}): Promise<void> {
  const workspaceId = workspace.id;

  // Determine datasource type from ENV
  const datasourceType = process.env.WORKSPACE_DATASOURCE === 'sharepoint'
    ? DataSourceTypeEnum.SHAREPOINT
    : DataSourceTypeEnum.POSTGRES;

  let schemaName: string;

  if (datasourceType === DataSourceTypeEnum.SHAREPOINT) {
    // ====== SharePoint Initialization ======
    const tenantId = process.env.WORKSPACE_TENANT_ID;
    if (!tenantId) {
      throw new Error('WORKSPACE_TENANT_ID must be set when WORKSPACE_DATASOURCE=sharepoint');
    }

    // Step 1: Get or create SharePoint site
    const site = await this.sharePointService.getTwentySiteForTenant(
      tenantId,
      workspace.displayName || workspace.subdomain,
    );

    // Step 2: Save siteId to workspace
    await this.workspaceRepository.update(workspaceId, {
      sharePointSiteId: site.id,
    });

    schemaName = 'sharepoint'; // Placeholder

  } else {
    // ====== PostgreSQL Initialization ======
    schemaName = await this.workspaceDataSourceService.createWorkspaceDBSchema(workspaceId);
  }

  // Create datasource metadata
  const dataSourceMetadata = await this.dataSourceService.createDataSourceMetadata(
    workspaceId,
    schemaName,
    datasourceType, // Pass type
  );

  const featureFlags = await this.featureFlagService.getWorkspaceFeatureFlagsMap(workspaceId);

  await this.applicationService.createTwentyStandardApplication({ workspaceId });

  // Sync metadata - creates ObjectMetadata in core DB
  await this.workspaceSyncMetadataService.synchronize({
    workspaceId,
    dataSourceId: dataSourceMetadata.id,
    featureFlags,
  });

  await this.setupDefaultRoles(workspaceId, userId);

  // SharePoint-specific: Create Lists after ObjectMetadata synced
  if (datasourceType === DataSourceTypeEnum.SHAREPOINT) {
    const tenantId = process.env.WORKSPACE_TENANT_ID!;
    const siteId = workspace.sharePointSiteId!;

    // Get synced ObjectMetadata
    const objectMetadataCollection =
      await this.objectMetadataServiceV2.findManyWithinWorkspace(workspaceId);

    // Initialize SharePoint Lists
    await this.sharePointWorkspaceInitService.initializeWorkspace(
      tenantId,
      siteId,
      objectMetadataCollection,
    );
  } else {
    // PostgreSQL: Prefill data
    await this.prefillWorkspaceWithStandardObjectsRecords(
      dataSourceMetadata,
      workspaceId,
      featureFlags,
    );
  }
}
```

### 3. DataSourceService.createDataSourceMetadata()

### Optional

```bash
# File storage type (defaults to same as datasource)
### 4. WorkspaceDatasourceFactory  # or 's3' | 'local'
```

## SharePoint Site Naming Convention

**Pattern**: `Twenty - {WorkspaceName}`

**Examples**:
- Workspace "Acme Corp" → Site "Twenty - Acme Corp"
- Workspace "sales-team" → Site "Twenty - sales-team"

**Lý do**:
- Dễ identify trong SharePoint admin center
- Unique per workspace
- Search được bằng display name
## Implementation Tasks

**Code đã có sẵn** (sử dụng existing services):
- ✅ SharePointService.getTwentySiteForTenant() - Tìm/tạo site
- ✅ SharePointWorkspaceInitService.initializeWorkspace() - Tạo Lists từ ObjectMetadata
- ✅ SharePointSchemaService - Map FieldMetadata → SharePoint columns
- ✅ SharePointRepository - CRUD operations
- ✅ SharePointWorkspaceDataSource - Datasource implementation

**Cần implement** (wire-up vào workspace creation):

### Phase 1: Database Migration
- [ ] Add `sharePointSiteId` column to WorkspaceEntity
- [ ] Create migration file: `ALTER TABLE core.workspace ADD COLUMN "sharePointSiteId" varchar NULL`

### Phase 2: Workspace Creation Integration
- [ ] Inject SharePointService và SharePointWorkspaceInitService vào WorkspaceManagerService
- [ ] Update WorkspaceManagerService.init() with SharePoint branch:
  * Check `WORKSPACE_DATASOURCE` env
  * Call `getTwentySiteForTenant()` để get/create site
  * Save siteId vào workspace record
  * After sync metadata: call `initializeWorkspace()` để tạo Lists
- [ ] Update DataSourceService.createDataSourceMetadata() để accept type parameter

### Phase 3: Datasource Factory
- [ ] Update WorkspaceDatasourceFactory để support SharePoint type
- [ ] Read siteId từ workspace.sharePointSiteId
- [ ] Read tenantId từ WORKSPACE_TENANT_ID env
- [ ] Return SharePointWorkspaceDataSource instance

### Phase 4: Testing
- [ ] Test workspace creation với WORKSPACE_DATASOURCE=sharepoint
- [ ] Verify site created trong SharePoint admin
- [ ] Verify Lists created với correct columns
- [ ] Test GraphQL queries (list companies, create company, etc.) branch
- [ ] Add ENV validation for required variables
- [ ] Update `DataSourceService.createDataSourceMetadata()` with type parameter

### Phase 4: Datasource Factory ✅
- [ ] Update `WorkspaceDatasourceFactory` to support SharePoint type
- [ ] Read siteId from `workspace.sharePointSiteId`
- [ ] Read tenantId from `WORKSPACE_TENANT_ID` ENV

### Phase 5: Testing ✅
- [ ] Test workspace creation with `WORKSPACE_DATASOURCE=sharepoint`
- [ ] Verify site creation in SharePoint
- [ ] Verify Lists creation
- [ ] Test CRUD operations via SharePointRepository
- [ ] Test migration from PostgreSQL to SharePoint (optional)

## Key Differences from Previous Design

| Aspect | Old Design (Complex) | New Design (Simple) |
|--------|---------------------|---------------------|
## Implementation Priority

1. **CRITICAL**: Database migration (add `sharePointSiteId` column)
2. **HIGH**: WorkspaceManagerService.init() integration - wire up existing SharePoint services
3. **HIGH**: DataSourceService.createDataSourceMetadata() type parameter
4. **MEDIUM**: WorkspaceDatasourceFactory SharePoint branch
5. **LOW**: Testing và validation
## Notes

1. **Self-hosted only**: Design này chỉ dành cho self-hosted deployment. Multi-tenant SaaS sẽ cần design khác.

2. **One-time initialization**: Site chỉ được tạo một lần khi workspace được tạo. Sau đó siteId được cache trong DB.

3. **No runtime overhead**: Không có detection/resolution logic trong runtime → performance tốt hơn.

4. **Simple troubleshooting**: Tất cả config đều visible trong ENV vars và database → dễ debug.

5. **Idempotent**: Nếu site đã tồn tại, logic chỉ verify và ensure Lists đầy đủ, không tạo lại.

6. **Workspace name changes**: Nếu workspace đổi tên, SharePoint site name KHÔNG đổi theo (vì siteId đã được cache). Cần logic riêng nếu muốn sync names.

## Implementation Priority

1. **CRITICAL**: Database migration (add `sharePointSiteId` column)
2. **HIGH**: SharePointService.initializeWorkspaceSite() implementation
3. **HIGH**: WorkspaceManagerService.init() SharePoint branch
4. **MEDIUM**: WorkspaceDatasourceFactory updates
5. **LOW**: Documentation và testing

## Request Flow Example: FE Call `list companies`

### Ví dụ cụ thể khi Frontend gọi GraphQL để list companies với SharePoint datasource:

```graphql
# Frontend GraphQL Query
query Companies {
  companies(first: 50, orderBy: [{ name: AscNullsFirst }]) {
    edges {
      node {
        id
        name
        domainName
        employees
        createdAt
      }
    }
    pageInfo {
      hasNextPage
      hasPreviousPage
    }
    totalCount
  }
}
```

### Complete Flow Trace:

```
1. GraphQL Request
   Frontend → POST /graphql
   Query: companies(first: 50, orderBy: [{ name: AscNullsFirst }])
   ↓

2. GraphQL Resolver Layer
   File: workspace-resolver.factory.ts
   - Route request đến FindManyResolverFactory
   - Extract args: { first: 50, orderBy: [{ name: 'AscNullsFirst' }] }
   ↓

3. Query Runner Service
   File: common-find-many-query-runner.service.ts
   - Nhận args và workspaceId từ auth context
   - Call: repository.find(options)

   Code flow:
   ```typescript
   const { repository, authContext, objectMetadataItemWithFieldMaps } = queryRunnerContext;

   // For SharePoint: repository is SharePointRepository instance
   const items = await repository.find({
     where: appliedFilters,
     order: orderByWithIdCondition,
     take: limit,
     skip: offset,
   });
   ```
   ↓

4. Repository Layer - SharePoint Implementation
   File: sharepoint.repository.ts

   Method: find(options?: FindManyOptions<T>)

   Code execution:
   ```typescript
   override async find(
     options?: FindManyOptions<T>,
     _entityManager?: WorkspaceEntityManager,
   ): Promise<T[]> {
     this.logger.debug('SharePoint find', { options });

     // STEP 4.1: Get access token
     const token = await this.ensureToken();
     // → Calls: sharePointService.getAppOnlyToken(tenantId)
     // → Returns: Microsoft Graph API access token

     // STEP 4.2: Convert TypeORM options to SharePoint query
     const queryOptions = this.buildSharePointQuery(options);
     // → Converts:
     //   where: { name: 'Acme' }
     //   → $filter: "fields/name eq 'Acme'"
     //
     //   orderBy: { name: 'ASC' }
     //   → $orderby: "fields/name asc"
     //
     //   take: 50
     //   → $top: 50

     // STEP 4.3: Call SharePoint REST API
     const items = await this.sharePointService.getListItems(
       this.siteId,        // From workspace.sharePointSiteId
       this.listId,        // 'companies' (from ObjectMetadata.namePlural)
       queryOptions,       // { $filter, $orderby, $top, $select }
       token,
     );
     // → HTTP GET: https://graph.microsoft.com/v1.0/sites/{siteId}/lists/{listId}/items
     //   ?$filter=fields/name eq 'Acme'
     //   &$orderby=fields/name asc
     //   &$top=50
     //   &$expand=fields

     // STEP 4.4: Transform SharePoint items to Twenty entities
     return this.transformToEntities(items);
     // → Converts SharePoint List items to Twenty Company objects:
     //   {
     //     id: item.id,
     //     name: item.fields.name,
     //     domainName: item.fields.domainName,
     //     employees: item.fields.employees,
     //     createdAt: item.createdDateTime,
     //   }
   }
   ```
   ↓

5. SharePoint Service Layer
   File: sharepoint.service.ts

   Method: getListItems(siteId, listId, queryOptions, token)

   Code execution:
   ```typescript
   async getListItems(
     siteId: string,
     listId: string,
     queryOptions: SharePointQueryOptions,
     token: string,
   ): Promise<SharePointListItem[]> {
     // Build Graph API URL
     const url = `/sites/${siteId}/lists/${listId}/items`;

     // Execute Graph API request
     const response = await this.graphClient
       .api(url)
       .query({
         $filter: queryOptions.filter,
         $orderby: queryOptions.orderBy,
         $top: queryOptions.top,
         $select: queryOptions.select,
         $expand: 'fields',  // Always expand to get field values
       })
       .headers({ Authorization: `Bearer ${token}` })
       .get();

     // response.value = [
     //   {
     //     id: "1",
     //     createdDateTime: "2025-11-22T10:00:00Z",
     //     fields: {
     //       id: "uuid-1",
     //       name: "Acme Corp",
     //       domainName: "acme.com",
     //       employees: 150,
     //     }
     //   },
     //   {
     //     id: "2",
     //     createdDateTime: "2025-11-22T11:00:00Z",
     //     fields: {
     //       id: "uuid-2",
     //       name: "Globex Corporation",
     //       domainName: "globex.com",
     //       employees: 500,
     //     }
     //   },
     //   ...
     // ]

     return response.value;
   }
   ```
   ↓

6. Microsoft Graph API
   URL: https://graph.microsoft.com/v1.0/sites/{siteId}/lists/companies/items
   Query params:
     - $filter: (optional) OData filter expression
     - $orderby: fields/name asc
     - $top: 50
     - $expand: fields

   Authentication: Bearer {token}

   SharePoint processes:
     - Query "companies" List in site "Twenty - Workspace Name"
     - Apply filters and sorting
     - Return JSON array of list items
   ↓

7. Response Transformation
   SharePointRepository.transformToEntities():

   ```typescript
   private transformToEntities(items: SharePointListItem[]): T[] {
     return items.map(item => {
       const entity = {} as T;

       // Map SharePoint fields to entity properties
       for (const [key, value] of Object.entries(item.fields)) {
         // Handle field type conversions
         if (this.isDateField(key)) {
           entity[key] = new Date(value);
         } else if (this.isRelationField(key)) {
           entity[key] = this.resolveRelation(value);
         } else {
           entity[key] = value;
         }
       }

       return entity;
     });
   }
   ```
   ↓

8. GraphQL Response Formatting
   File: object-records-to-graphql-connection.helper.ts

   Transform to GraphQL Connection format:
   ```typescript
   {
     edges: [
       { node: { id: "uuid-1", name: "Acme Corp", ... } },
       { node: { id: "uuid-2", name: "Globex Corporation", ... } },
     ],
     pageInfo: {
       hasNextPage: false,
       hasPreviousPage: false,
       startCursor: "cursor-1",
       endCursor: "cursor-50",
     },
     totalCount: 2
   }
   ```
   ↓

9. GraphQL Response
   Backend → Frontend
   Status: 200 OK
   Content-Type: application/json

   Body: {
     "data": {
       "companies": {
         "edges": [...],
         "pageInfo": {...},
         "totalCount": 2
       }
     }
   }
```

### Key Components in SharePoint Flow:

1. **Repository Layer Abstraction**:
   - `WorkspaceRepository` interface → `SharePointRepository` implementation
   - Same API surface as PostgreSQL repository
   - Transparent to upper layers (GraphQL resolvers don't know about SharePoint)

2. **Query Translation**:
   - TypeORM FindOptions → OData query parameters
   - `where: { name: 'Acme' }` → `$filter: "fields/name eq 'Acme'"`
   - `order: { name: 'ASC' }` → `$orderby: "fields/name asc"`

3. **SharePoint List as Database Table**:
   - List name: `companies` (from ObjectMetadata.namePlural)
   - Columns: Dynamic from FieldMetadata
   - Rows: List items with fields

4. **Authentication Flow**:
   - App-only token (client credentials flow)
   - Token cached in repository instance
   - Reused for multiple requests

5. **Data Transformation**:
   - SharePoint List Item → Twenty Entity object
   - Field type mapping (date, number, relation, etc.)
   - Maintains same schema as PostgreSQL version

### Performance Considerations:

| Aspect | PostgreSQL | SharePoint |
|--------|-----------|------------|
| Query latency | ~5-20ms (local) | ~100-300ms (Graph API call) |
| Batch operations | Native support | Requires $batch API |
| Transactions | Full ACID support | Limited (List item level only) |
| Complex joins | Efficient | Multiple API calls needed |
| Caching | Query result caching | Token caching + result caching |

### Differences from PostgreSQL Flow:

```diff
PostgreSQL:
  GraphQL → QueryRunner → TypeORM Repository → SQL Query → PostgreSQL → Rows → Transform → Response

SharePoint:
  GraphQL → QueryRunner → SharePoint Repository → OData Query → Graph API → SharePoint List → Items → Transform → Response
                                                                    ↑
                                                              Extra network hop
```

**Key difference**: SharePoint adds network latency (Graph API call) but provides native M365 integration.

## Current Implementation Status

### ✅ Đã có code (nhưng chưa được integrate vào workspace creation):

1. **SharePointService** (`sharepoint.service.ts`):
   - ✅ `getAppOnlyToken(tenantId)` - Get Microsoft Graph API token
   - ✅ `getTwentySiteForTenant(tenantId, tenantName, token)` - Get or create Twenty site
   - ✅ `findTwentySite(siteName, token)` - Search for existing site by name
   - ✅ `createTwentySite(siteName, tenantName, token)` - Create new SharePoint site
   - ✅ `getSiteLists(siteId, token)` - Get all lists in a site
   - ✅ `createList(siteId, listRequest, token)` - Create SharePoint list
   - ✅ `getListColumns(siteId, listId, token)` - Get list columns
   - ✅ `getListItems()`, `createListItem()`, `updateListItem()`, `deleteListItem()` - CRUD operations

2. **SharePointSchemaService** (`sharepoint-schema.service.ts`):
   - ✅ `createListFromObjectMetadata(siteId, objectMetadata, token)` - Convert ObjectMetadata → SharePoint List with columns
   - ✅ `generateListSchema(objectMetadata)` - Generate SharePoint schema from ObjectMetadata
   - ✅ `mapFieldToColumn(field)` - Map Twenty field types to SharePoint column types
   - ✅ `createColumn()` - Create individual SharePoint column
   - ✅ `updateLookupColumn()` - Update Lookup columns for relationships
   - ✅ `syncObjectMetadata()` - Sync schema changes to SharePoint

3. **SharePointWorkspaceInitService** (`sharepoint-workspace-init.service.ts`):
### ❌ Chưa có (cần wire-up):

1. **WorkspaceManagerService.init()** - Integration với existing SharePoint services:
   ```typescript
   // CURRENT - Only PostgreSQL
   const schemaName = await this.workspaceDataSourceService.createWorkspaceDBSchema(workspaceId);

   // NEEDED - Add SharePoint branch sử dụng existing services:
   if (process.env.WORKSPACE_DATASOURCE === 'sharepoint') {
     const tenantId = process.env.WORKSPACE_TENANT_ID;

     // Use existing: SharePointService.getTwentySiteForTenant()
     const site = await this.sharePointService.getTwentySiteForTenant(
       tenantId,
       workspace.displayName
     );

     await this.workspaceRepository.update(workspaceId, {
       sharePointSiteId: site.id
     });

     schemaName = 'sharepoint';
   }

   // ... after workspaceSyncMetadataService.synchronize() ...

   // NEEDED - Create Lists using existing SharePointWorkspaceInitService:
   if (datasourceType === DataSourceTypeEnum.SHAREPOINT) {
     const objectMetadataCollection =
       await this.objectMetadataServiceV2.findManyWithinWorkspace(workspaceId);

     // Use existing: SharePointWorkspaceInitService.initializeWorkspace()
     await this.sharePointWorkspaceInitService.initializeWorkspace(
       tenantId,
       site.id,
       objectMetadataCollection
     );
   }
   ```
     // Get ObjectMetadata collection
     const objectMetadataCollection = await this.objectMetadataServiceV2.findManyWithinWorkspace(workspaceId);

     // Initialize workspace (create all Lists)
     await this.sharePointWorkspaceInitService.initializeWorkspace(
       tenantId,
       site.id,
       objectMetadataCollection
     );

     // Save siteId to workspace
     await this.workspaceRepository.update(workspaceId, { sharePointSiteId: site.id });

     // Create datasource metadata with SharePoint type
     const dataSourceMetadata = await this.dataSourceService.createDataSourceMetadata(
       workspaceId,
       'sharepoint',
       DataSourceTypeEnum.SHAREPOINT
     );
   }
   ```

2. **WorkspaceEntity.sharePointSiteId** column:
   ```sql
   ALTER TABLE core.workspace ADD COLUMN "sharePointSiteId" varchar NULL;
   ```

3. **WorkspaceDatasourceFactory** - SharePoint branch:
   ```typescript
   // CURRENT CODE - Only creates PostgreSQL datasource

   // MISSING - SharePoint datasource creation:
   if (dataSourceMetadata.type === DataSourceTypeEnum.SHAREPOINT) {
     const siteId = workspace.sharePointSiteId;
     const tenantId = process.env.WORKSPACE_TENANT_ID;

     return new SharePointWorkspaceDataSource(
       internalContext,
       {} as DataSourceOptions,
       featureFlagMapVersion,
       featureFlagMap,
       rolesPermissionsVersion,
       permissionsPerRoleId,
       isPoolSharingEnabled,
       this.sharePointService,
       { workspaceId, tenantId, siteId }
     );
   }
   ```

4. **DataSourceService.createDataSourceMetadata()** - Type parameter:
   ```typescript
   // CURRENT:
   async createDataSourceMetadata(workspaceId: string, schema: string): Promise<DataSourceEntity>

   // NEEDED:
   async createDataSourceMetadata(
     workspaceId: string,
     schema: string,
     dataSourceType?: DataSourceTypeEnum  // Add this parameter
   ): Promise<DataSourceEntity>
   ```

### 📋 Summary:

**Code infrastructure**: ~80% complete
- ✅ All SharePoint services implemented
- ✅ Schema mapping logic complete
- ✅ Repository layer complete
- ✅ Datasource implementation complete

**Integration**: ~20% complete
- ❌ WorkspaceManagerService chưa gọi SharePoint initialization
- ❌ WorkspaceEntity chưa có sharePointSiteId column
- ❌ WorkspaceDatasourceFactory chưa support SharePoint type
- ❌ DataSourceService chưa có type parameter

**Vấn đề chính**:
Code đã viết đầy đủ logic cho SharePoint, nhưng **chưa được integrate vào workspace creation flow**. WorkspaceManagerService.init() hiện chỉ tạo PostgreSQL schema, không có branch cho SharePoint.

**Next steps theo design doc**:
1. Add `sharePointSiteId` column to WorkspaceEntity
2. Update WorkspaceManagerService.init() để check `WORKSPACE_DATASOURCE` env và gọi SharePoint initialization
3. Update DataSourceService.createDataSourceMetadata() với type parameter
4. Update WorkspaceDatasourceFactory để create SharePoint datasource

---

**Created**: 2025-11-22
**Status**: Design phase - ready for implementation
**Next Step**: Phase 1 - Database migration
