/*
  Warnings:

  - You are about to drop the column `createdAt` on the `budgets` table. All the data in the column will be lost.
  - You are about to drop the column `month` on the `budgets` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `budgets` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `budgets` table. All the data in the column will be lost.
  - You are about to drop the column `year` on the `budgets` table. All the data in the column will be lost.
  - You are about to drop the column `category` on the `transactions` table. All the data in the column will be lost.
  - Added the required column `category_id` to the `budgets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `end_date` to the `budgets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `name` to the `budgets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `period` to the `budgets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `start_date` to the `budgets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `budgets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `user_id` to the `budgets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `category_id` to the `transactions` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "budgets" DROP CONSTRAINT "budgets_userId_fkey";

-- DropIndex
DROP INDEX "budgets_userId_month_year_key";

-- AlterTable
ALTER TABLE "budgets" DROP COLUMN "createdAt",
DROP COLUMN "month",
DROP COLUMN "updatedAt",
DROP COLUMN "userId",
DROP COLUMN "year",
ADD COLUMN     "alert_percentage" DOUBLE PRECISION NOT NULL DEFAULT 85,
ADD COLUMN     "category_id" TEXT NOT NULL,
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "end_date" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "period" TEXT NOT NULL,
ADD COLUMN     "spent" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "start_date" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "user_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "transactions" DROP COLUMN "category",
ADD COLUMN     "category_id" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "icon" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
