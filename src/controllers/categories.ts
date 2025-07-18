import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const getCategories = async (req: Request, res: Response) => {
  try {
    const categories = await prisma.category.findMany({
      select: {
        id: true,
        name: true,
        icon: true,
        type: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true
      },
      where: { 
        isDefault: true 
      },
      orderBy: [
        { type: 'asc' },
        { name: 'asc' }
      ]
    });

    res.json(categories);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ 
      error: 'Error interno del servidor al obtener categorías' 
    });
  }
};

export const createCategory = async (req: Request, res: Response) => {
  try {
    const { name, type, icon }: { name: string; type: 'INCOME' | 'EXPENSE'; icon: string } = req.body;

    // Validaciones
    if (!name || !type || !icon) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Name, type, and icon are required'
      });
    }

    if (!['INCOME', 'EXPENSE'].includes(type)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Type must be either INCOME or EXPENSE'
      });
    }

    const category = await prisma.category.create({
      data: {
        name,
        type,
        icon,
        isDefault: false // Las categorías creadas por el usuario no son por defecto
      },
      select: {
        id: true,
        name: true,
        type: true,
        icon: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true
      }
    });

    return res.status(201).json({
      message: 'Category created successfully',
      category
    });
  } catch (error) {
    console.error('Create category error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to create category'
    });
  }
};

export const updateCategory = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, icon }: { name?: string; icon?: string } = req.body;

    // Verificar que la categoría existe
    const existingCategory = await prisma.category.findUnique({
      where: { id }
    });

    if (!existingCategory) {
      return res.status(404).json({
        error: 'Category not found',
        message: 'Category does not exist'
      });
    }

    // No permitir modificar categorías por defecto
    if (existingCategory.isDefault) {
      return res.status(403).json({
        error: 'Cannot modify default category',
        message: 'Default categories cannot be modified'
      });
    }

    const category = await prisma.category.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(icon && { icon })
      },
      select: {
        id: true,
        name: true,
        type: true,
        icon: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true
      }
    });

    return res.json({
      message: 'Category updated successfully',
      category
    });
  } catch (error) {
    console.error('Update category error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to update category'
    });
  }
};

export const deleteCategory = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Verificar que la categoría existe
    const existingCategory = await prisma.category.findUnique({
      where: { id }
    });

    if (!existingCategory) {
      return res.status(404).json({
        error: 'Category not found',
        message: 'Category does not exist'
      });
    }

    // No permitir eliminar categorías por defecto
    if (existingCategory.isDefault) {
      return res.status(403).json({
        error: 'Cannot delete default category',
        message: 'Default categories cannot be deleted'
      });
    }

    // Verificar si hay transacciones o presupuestos usando esta categoría
    const [transactionsCount, budgetsCount] = await Promise.all([
      prisma.transaction.count({
        where: { category_id: id }
      }),
      prisma.budget.count({
        where: { category_id: id }
      })
    ]);

    if (transactionsCount > 0 || budgetsCount > 0) {
      return res.status(409).json({
        error: 'Category in use',
        message: `Cannot delete category that is being used by ${transactionsCount} transactions and ${budgetsCount} budgets`
      });
    }

    await prisma.category.delete({
      where: { id }
    });

    return res.json({
      message: 'Category deleted successfully'
    });
  } catch (error) {
    console.error('Delete category error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to delete category'
    });
  }
}; 