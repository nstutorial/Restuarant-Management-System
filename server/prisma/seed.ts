import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const restaurant = await prisma.restaurant.upsert({
    where: { id: 'demo-hearth-grain' },
    update: {},
    create: { id: 'demo-hearth-grain', name: 'Hearth & Grain' },
  });
  const branch = await prisma.branch.upsert({
    where: { id: 'demo-indiranagar' },
    update: {},
    create: { id: 'demo-indiranagar', restaurantId: restaurant.id, name: 'Indiranagar' },
  });
  const categories = ['Starters', 'Mains', 'Sides', 'Desserts', 'Drinks'];
  for (const [sortOrder, name] of categories.entries()) {
    await prisma.menuCategory.upsert({
      where: { branchId_name: { branchId: branch.id, name } },
      update: {},
      create: { branchId: branch.id, name, sortOrder },
    });
  }
  const menu = [
    { name: 'Truffle Mushroom Risotto', category: 'Mains', price: '420.00', emoji: '🍄', description: 'Wild mushroom · parmesan · truffle oil' },
    { name: 'Burrata & Heirloom Tomato', category: 'Starters', price: '360.00', emoji: '🍅', description: 'Basil · aged balsamic · sourdough' },
    { name: 'Grilled Sea Bass', category: 'Mains', price: '590.00', emoji: '🐟', description: 'Lemon butter · charred greens · capers' },
    { name: 'Roasted Pumpkin Soup', category: 'Starters', price: '240.00', emoji: '🎃', description: 'Sage cream · toasted seeds' },
    { name: 'Dark Chocolate Fondant', category: 'Desserts', price: '280.00', emoji: '🍫', description: 'Vanilla bean ice cream · sea salt' },
    { name: 'Strawberry Elderflower Spritz', category: 'Drinks', price: '220.00', emoji: '🍹', description: 'Fresh strawberry · elderflower · soda' },
    { name: 'Sourdough & Whipped Butter', category: 'Starters', price: '160.00', emoji: '🥖', description: 'House fermented · cultured butter' },
    { name: 'Hand-cut Truffle Fries', category: 'Sides', price: '190.00', emoji: '🍟', description: 'Rosemary · parmesan · aioli' },
    { name: 'Espresso Martini', category: 'Drinks', price: '320.00', emoji: '🍸', description: 'Double espresso · vodka · cacao' },
    { name: 'Lemon Olive Oil Cake', category: 'Desserts', price: '260.00', emoji: '🍋', description: 'Candied citrus · mascarpone cream' },
  ];
  for (const [index, item] of menu.entries()) {
    const category = await prisma.menuCategory.findUniqueOrThrow({ where: { branchId_name: { branchId: branch.id, name: item.category } } });
    await prisma.menuItem.upsert({
      where: { branchId_sku: { branchId: branch.id, sku: `DEMO-${index + 1}` } },
      update: {},
      create: { branchId: branch.id, categoryId: category.id, sku: `DEMO-${index + 1}`, name: item.name, description: item.description, price: item.price, emoji: item.emoji },
    });
  }
  for (let number = 1; number <= 12; number++) {
    await prisma.diningTable.upsert({
      where: { branchId_number: { branchId: branch.id, number: String(number).padStart(2, '0') } },
      update: {},
      create: { branchId: branch.id, number: String(number).padStart(2, '0'), seats: number % 4 === 0 ? 6 : number % 3 === 0 ? 4 : 2, status: 'AVAILABLE' },
    });
  }
  const ownerEmail = process.env.BOOTSTRAP_OWNER_EMAIL?.trim().toLowerCase();
  const ownerPassword = process.env.BOOTSTRAP_OWNER_PASSWORD;
  if (ownerEmail && ownerPassword) {
    if (ownerPassword.length < 12) throw new Error('BOOTSTRAP_OWNER_PASSWORD must contain at least 12 characters.');
    const owner = await prisma.user.upsert({
      where: { email: ownerEmail },
      update: {},
      create: { name: process.env.BOOTSTRAP_OWNER_NAME?.trim() || 'Restaurant Owner', email: ownerEmail, passwordHash: await hash(ownerPassword, 12) },
    });
    await prisma.branchMembership.upsert({
      where: { userId_branchId: { userId: owner.id, branchId: branch.id } },
      update: {},
      create: { userId: owner.id, branchId: branch.id, role: 'OWNER' },
    });
    console.log(`Configured owner account ${owner.email}; existing credentials were preserved.`);
  } else {
    console.log('Owner account not configured. Set BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD, then rerun the seed.');
  }
  console.log(`Seeded demo restaurant ${restaurant.name} / ${branch.name}; existing records were preserved.`);
}

main().finally(() => prisma.$disconnect());
