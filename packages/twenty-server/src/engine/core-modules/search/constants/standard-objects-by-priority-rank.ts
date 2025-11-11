//the higher the number, the higher the priority
export const STANDARD_OBJECTS_BY_PRIORITY_RANK = {
  person: 5,
  company: 4,
  opportunity: 3,

  material: 3, // High priority - core materials
  supplier: 3, // High priority - core supplier info
  manufacturer: 3, // High priority - core manufacturer info
  materialGroup: 2, // Medium priority - material categorization
  employee: 2,
  note: 2,

  task: 1,
  department: 1,
  team: 1,

  warehouse: 2, // Medium priority - inventory location
  organizationPosition: 0,
  employeeLevel: 0,
  employmentType: 0,
  employeeAward: 0,
};
