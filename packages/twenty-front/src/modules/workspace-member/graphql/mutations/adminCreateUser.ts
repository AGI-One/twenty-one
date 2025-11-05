import { gql } from '@apollo/client';

export const ADMIN_CREATE_USER = gql`
  mutation AdminCreateUser($adminCreateUserInput: AdminCreateUserInput!) {
    adminCreateUser(adminCreateUserInput: $adminCreateUserInput) {
      id
      email
      firstName
      lastName
      isEmailVerified
    }
  }
`;
