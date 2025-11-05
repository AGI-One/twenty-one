import { Field, InputType } from '@nestjs/graphql';

import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

@InputType()
export class AdminCreateUserInput {
  @Field(() => String)
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @Field(() => String)
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @Field(() => String)
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @Field(() => String)
  @IsString()
  @IsNotEmpty()
  password: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  locale?: string;
}
