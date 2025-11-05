import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class AdminCreateUserOutput {
  @Field(() => String)
  id: string;

  @Field(() => String)
  email: string;

  @Field(() => String)
  firstName: string;

  @Field(() => String)
  lastName: string;

  @Field(() => Boolean)
  isEmailVerified: boolean;
}
