import { useSnackBar } from '@/ui/feedback/snack-bar-manager/hooks/useSnackBar';
import { useMutation } from '@apollo/client';
import { ADMIN_CREATE_USER } from '../graphql/mutations/adminCreateUser';

export const useAdminCreateUser = () => {
  const { enqueueSuccessSnackBar, enqueueErrorSnackBar } = useSnackBar();

  const [adminCreateUserMutation, { loading }] = useMutation(
    ADMIN_CREATE_USER,
    {
      onCompleted: (data) => {
        enqueueSuccessSnackBar({
          message: `User ${data.adminCreateUser.firstName} ${data.adminCreateUser.lastName} created successfully`,
        });
      },
      onError: (error) => {
        enqueueErrorSnackBar({
          message: `Failed to create user: ${error.message}`,
        });
      },
    },
  );

  const adminCreateUser = async (userData: {
    email: string;
    firstName: string;
    lastName: string;
    password: string;
    locale?: string;
  }) => {
    return await adminCreateUserMutation({
      variables: {
        adminCreateUserInput: userData,
      },
    });
  };

  return {
    adminCreateUser,
    loading,
  };
};
