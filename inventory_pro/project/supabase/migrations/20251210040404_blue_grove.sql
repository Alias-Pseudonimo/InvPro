/*
  # Create Inventory Management Schema

  1. New Tables
    - `products`
      - `id` (uuid, primary key)
      - `upc` (text, unique identifier)
      - `name` (text, product name)
      - `description` (text, product description)
      - `picture` (text, image URL)
      - `purchase_price` (decimal, cost price)
      - `sales_price` (decimal, selling price)
      - `in_stock` (integer, current stock)
      - `value_on_hand` (decimal, calculated value)
      - `created_at` (timestamp)
      - `updated_at` (timestamp)
    
    - `customers`
      - `id` (uuid, primary key)
      - `name` (text, customer name)
      - `email` (text, customer email)
      - `phone` (text, customer phone)
      - `address` (text, customer address)
      - `city` (text, customer city)
      - `state` (text, customer state)
      - `zip_code` (text, customer zip code)
      - `created_at` (timestamp)
      - `updated_at` (timestamp)
    
    - `suppliers`
      - `id` (uuid, primary key)
      - `name` (text, supplier name)
      - `email` (text, supplier email)
      - `phone` (text, supplier phone)
      - `address` (text, supplier address)
      - `city` (text, supplier city)
      - `state` (text, supplier state)
      - `zip_code` (text, supplier zip code)
      - `created_at` (timestamp)
      - `updated_at` (timestamp)
    
    - `purchases`
      - `id` (uuid, primary key)
      - `supplier_id` (uuid, foreign key to suppliers)
      - `product_id` (uuid, foreign key to products)
      - `quantity` (integer, purchase quantity)
      - `unit_price` (decimal, price per unit)
      - `total_amount` (decimal, total purchase amount)
      - `date` (date, purchase date)
      - `status` (text, purchase status)
      - `created_at` (timestamp)
      - `updated_at` (timestamp)
    
    - `sales`
      - `id` (uuid, primary key)
      - `customer_id` (uuid, foreign key to customers)
      - `total_amount` (decimal, total sale amount)
      - `date` (date, sale date)
      - `status` (text, sale status)
      - `created_at` (timestamp)
      - `updated_at` (timestamp)
    
    - `sale_items`
      - `id` (uuid, primary key)
      - `sale_id` (uuid, foreign key to sales)
      - `product_id` (uuid, foreign key to products)
      - `quantity` (integer, item quantity)
      - `unit_price` (decimal, price per unit)
      - `created_at` (timestamp)
    
    - `business_info`
      - `id` (uuid, primary key)
      - `name` (text, business name)
      - `address` (text, business address)
      - `city` (text, business city)
      - `state` (text, business state)
      - `zip_code` (text, business zip code)
      - `phone` (text, business phone)
      - `email` (text, business email)
      - `website` (text, business website)
      - `tax_id` (text, business tax ID)
      - `logo` (text, logo URL)
      - `created_at` (timestamp)
      - `updated_at` (timestamp)

  2. Security
    - Enable RLS on all tables
    - Add policies for authenticated users to manage their own data
*/

-- Create products table
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upc text UNIQUE NOT NULL,
  name text NOT NULL,
  description text DEFAULT '',
  picture text DEFAULT '',
  purchase_price decimal(10,2) NOT NULL DEFAULT 0,
  sales_price decimal(10,2) NOT NULL DEFAULT 0,
  in_stock integer NOT NULL DEFAULT 0,
  value_on_hand decimal(10,2) NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create customers table
CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  address text DEFAULT '',
  city text DEFAULT '',
  state text DEFAULT '',
  zip_code text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create suppliers table
CREATE TABLE IF NOT EXISTS suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  address text DEFAULT '',
  city text DEFAULT '',
  state text DEFAULT '',
  zip_code text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create purchases table
CREATE TABLE IF NOT EXISTS purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid REFERENCES suppliers(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  quantity integer NOT NULL DEFAULT 1,
  unit_price decimal(10,2) NOT NULL DEFAULT 0,
  total_amount decimal(10,2) NOT NULL DEFAULT 0,
  date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'received', 'cancelled')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create sales table
CREATE TABLE IF NOT EXISTS sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  total_amount decimal(10,2) NOT NULL DEFAULT 0,
  date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create sale_items table
CREATE TABLE IF NOT EXISTS sale_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid REFERENCES sales(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  quantity integer NOT NULL DEFAULT 1,
  unit_price decimal(10,2) NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Create business_info table
CREATE TABLE IF NOT EXISTS business_info (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'Your Business Name',
  address text DEFAULT '',
  city text DEFAULT '',
  state text DEFAULT '',
  zip_code text DEFAULT '',
  phone text DEFAULT '',
  email text DEFAULT '',
  website text DEFAULT '',
  tax_id text DEFAULT '',
  logo text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_info ENABLE ROW LEVEL SECURITY;

-- Create policies for authenticated users
CREATE POLICY "Users can manage products"
  ON products
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Users can manage customers"
  ON customers
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Users can manage suppliers"
  ON suppliers
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Users can manage purchases"
  ON purchases
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Users can manage sales"
  ON sales
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Users can manage sale items"
  ON sale_items
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Users can manage business info"
  ON business_info
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_products_upc ON products(upc);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_suppliers_email ON suppliers(email);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier_id ON purchases(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchases_product_id ON purchases(product_id);
CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(date);
CREATE INDEX IF NOT EXISTS idx_sales_customer_id ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product_id ON sale_items(product_id);

-- Insert default business info record
INSERT INTO business_info (name) VALUES ('Your Business Name')
ON CONFLICT DO NOTHING;