import React, { createContext, useContext, useState, ReactNode } from 'react';
import { LocalStorageDB } from '../lib/supabase';

export interface Product {
  id: string;
  upc: string;
  name: string;
  description: string;
  picture: string;
  purchasePrice: number;
  salesPrice: number;
  inStock: number;
  valueOnHand: number;
  supplierId?: string;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
}

export interface Supplier {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
}

export interface Purchase {
  id: string;
  supplierId: string;
  productId: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  date: string;
  status: 'pending' | 'received' | 'cancelled';
}

export interface Sale {
  id: string;
  customerId: string;
  items: {
    productId: string;
    quantity: number;
    unitPrice: number;
  }[];
  totalAmount: number;
  date: string;
  status: 'pending' | 'completed' | 'cancelled';
}

export interface BusinessInfo {
  name: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  phone: string;
  email: string;
  website: string;
  taxId: string;
  logo: string;
}

interface InventoryContextType {
  products: Product[];
  customers: Customer[];
  suppliers: Supplier[];
  purchases: Purchase[];
  sales: Sale[];
  businessInfo: BusinessInfo;
  addProduct: (product: Omit<Product, 'id' | 'valueOnHand'>) => void;
  updateProduct: (id: string, product: Partial<Product>) => void;
  deleteProduct: (id: string) => void;
  addCustomer: (customer: Omit<Customer, 'id'>) => void;
  updateCustomer: (id: string, customer: Partial<Customer>) => void;
  deleteCustomer: (id: string) => void;
  addSupplier: (supplier: Omit<Supplier, 'id'>) => void;
  updateSupplier: (id: string, supplier: Partial<Supplier>) => void;
  deleteSupplier: (id: string) => void;
  addPurchase: (purchase: Omit<Purchase, 'id'>) => void;
  updatePurchase: (id: string, purchase: Partial<Purchase>) => void;
  addSale: (sale: Omit<Sale, 'id'>) => void;
  updateSale: (id: string, sale: Partial<Sale>) => void;
  updateBusinessInfo: (info: BusinessInfo) => void;
}

const InventoryContext = createContext<InventoryContextType | undefined>(undefined);

const generateId = () => Math.random().toString(36).substr(2, 9);

// Storage keys
const STORAGE_KEYS = {
  PRODUCTS: 'inventory_products',
  CUSTOMERS: 'inventory_customers',
  SUPPLIERS: 'inventory_suppliers',
  PURCHASES: 'inventory_purchases',
  SALES: 'inventory_sales',
  BUSINESS_INFO: 'inventory_business_info'
};

const initialProducts: Product[] = [
  {
    id: '1',
    upc: '123456789012',
    name: 'Wireless Headphones',
    description: 'High-quality wireless headphones with noise cancellation',
    picture: 'https://images.pexels.com/photos/205926/pexels-photo-205926.jpeg?auto=compress&cs=tinysrgb&w=400',
    purchasePrice: 45.00,
    salesPrice: 89.99,
    inStock: 25,
    valueOnHand: 1125.00
  },
  {
    id: '2',
    upc: '234567890123',
    name: 'Smartphone Case',
    description: 'Durable protective case for smartphones',
    picture: 'https://images.pexels.com/photos/341523/pexels-photo-341523.jpeg?auto=compress&cs=tinysrgb&w=400',
    purchasePrice: 8.50,
    salesPrice: 19.99,
    inStock: 150,
    valueOnHand: 1275.00
  },
  {
    id: '3',
    upc: '345678901234',
    name: 'Bluetooth Speaker',
    description: 'Portable Bluetooth speaker with excellent sound quality',
    picture: 'https://images.pexels.com/photos/1649771/pexels-photo-1649771.jpeg?auto=compress&cs=tinysrgb&w=400',
    purchasePrice: 25.00,
    salesPrice: 49.99,
    inStock: 40,
    valueOnHand: 1000.00
  }
];

const initialCustomers: Customer[] = [
  {
    id: '1',
    name: 'John Smith',
    email: 'john.smith@email.com',
    phone: '(555) 123-4567',
    address: '123 Main St',
    city: 'New York',
    state: 'NY',
    zipCode: '10001'
  },
  {
    id: '2',
    name: 'Sarah Johnson',
    email: 'sarah.johnson@email.com',
    phone: '(555) 234-5678',
    address: '456 Oak Ave',
    city: 'Los Angeles',
    state: 'CA',
    zipCode: '90210'
  }
];

const initialSuppliers: Supplier[] = [
  {
    id: '1',
    name: 'Tech Distributors Inc',
    email: 'orders@techdist.com',
    phone: '(555) 987-6543',
    address: '789 Industrial Blvd',
    city: 'Chicago',
    state: 'IL',
    zipCode: '60601'
  },
  {
    id: '2',
    name: 'Global Electronics Supply',
    email: 'sales@globales.com',
    phone: '(555) 876-5432',
    address: '321 Commerce St',
    city: 'Atlanta',
    state: 'GA',
    zipCode: '30309'
  }
];

const initialBusinessInfo: BusinessInfo = {
  name: 'Your Business Name',
  address: '',
  city: '',
  state: '',
  zipCode: '',
  phone: '',
  email: '',
  website: '',
  taxId: '',
  logo: ''
};

export const InventoryProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  // Load data from localStorage or use initial data
  const [products, setProducts] = useState<Product[]>(() => {
    const stored = LocalStorageDB.get(STORAGE_KEYS.PRODUCTS, null);
    return stored && stored.length > 0 ? stored : initialProducts;
  });
  
  const [customers, setCustomers] = useState<Customer[]>(() => {
    const stored = LocalStorageDB.get(STORAGE_KEYS.CUSTOMERS, null);
    return stored && stored.length > 0 ? stored : initialCustomers;
  });
  
  const [suppliers, setSuppliers] = useState<Supplier[]>(() => {
    const stored = LocalStorageDB.get(STORAGE_KEYS.SUPPLIERS, null);
    return stored && stored.length > 0 ? stored : initialSuppliers;
  });
  
  const [purchases, setPurchases] = useState<Purchase[]>(() => 
    LocalStorageDB.get(STORAGE_KEYS.PURCHASES, [])
  );
  
  const [sales, setSales] = useState<Sale[]>(() => 
    LocalStorageDB.get(STORAGE_KEYS.SALES, [])
  );
  
  const [businessInfo, setBusinessInfo] = useState<BusinessInfo>(() => 
    LocalStorageDB.get(STORAGE_KEYS.BUSINESS_INFO, initialBusinessInfo)
  );

  const calculateValueOnHand = (purchasePrice: number, inStock: number) => {
    return purchasePrice * inStock;
  };

  const addProduct = (productData: Omit<Product, 'id' | 'valueOnHand'>) => {
    const newProduct: Product = {
      ...productData,
      id: generateId(),
      valueOnHand: calculateValueOnHand(productData.purchasePrice, productData.inStock)
    };
    setProducts(prev => {
      const updated = [...prev, newProduct];
      LocalStorageDB.set(STORAGE_KEYS.PRODUCTS, updated);
      return updated;
    });
  };

  const updateProduct = (id: string, productData: Partial<Product>) => {
    setProducts(prev => {
      const updated = prev.map(product => {
        if (product.id === id) {
          const updated = { ...product, ...productData };
          updated.valueOnHand = calculateValueOnHand(updated.purchasePrice, updated.inStock);
          return updated;
        }
        return product;
      });
      return updated;
    });
  };

  const deleteProduct = (id: string) => {
    setProducts(prev => {
      const updated = prev.filter(product => product.id !== id);
      LocalStorageDB.set(STORAGE_KEYS.PRODUCTS, updated);
      return updated;
    });
  };

  const addCustomer = (customerData: Omit<Customer, 'id'>) => {
    const newCustomer: Customer = {
      ...customerData,
      id: generateId()
    };
    setCustomers(prev => {
      const updated = [...prev, newCustomer];
      LocalStorageDB.set(STORAGE_KEYS.CUSTOMERS, updated);
      return updated;
    });
  };

  const updateCustomer = (id: string, customerData: Partial<Customer>) => {
    setCustomers(prev => {
      const updated = prev.map(customer => 
        customer.id === id ? { ...customer, ...customerData } : customer
      );
      LocalStorageDB.set(STORAGE_KEYS.CUSTOMERS, updated);
      return updated;
    });
  };

  const deleteCustomer = (id: string) => {
    setCustomers(prev => {
      const updated = prev.filter(customer => customer.id !== id);
      LocalStorageDB.set(STORAGE_KEYS.CUSTOMERS, updated);
      return updated;
    });
  };

  const addSupplier = (supplierData: Omit<Supplier, 'id'>) => {
    const newSupplier: Supplier = {
      ...supplierData,
      id: generateId()
    };
    setSuppliers(prev => {
      const updated = [...prev, newSupplier];
      LocalStorageDB.set(STORAGE_KEYS.SUPPLIERS, updated);
      return updated;
    });
  };

  const updateSupplier = (id: string, supplierData: Partial<Supplier>) => {
    setSuppliers(prev => {
      const updated = prev.map(supplier => 
        supplier.id === id ? { ...supplier, ...supplierData } : supplier
      );
      LocalStorageDB.set(STORAGE_KEYS.SUPPLIERS, updated);
      return updated;
    });
  };

  const deleteSupplier = (id: string) => {
    setSuppliers(prev => {
      const updated = prev.filter(supplier => supplier.id !== id);
      LocalStorageDB.set(STORAGE_KEYS.SUPPLIERS, updated);
      return updated;
    });
  };

  const addSale = (saleData: Omit<Sale, 'id'>) => {
    const newSale: Sale = {
      ...saleData,
      id: generateId()
    };
    
    // Update inventory for completed sales
    if (newSale.status === 'completed') {
      setProducts(prev => {
        const updated = prev.map(product => {
          const saleItem = newSale.items.find(item => item.productId === product.id);
          if (saleItem) {
            const newStock = Math.max(0, product.inStock - saleItem.quantity);
            return {
              ...product,
              inStock: newStock,
              valueOnHand: calculateValueOnHand(product.purchasePrice, newStock)
            };
          }
          return product;
        });
        LocalStorageDB.set(STORAGE_KEYS.PRODUCTS, updated);
        return updated;
      });
    }
    
    setSales(prev => {
      const updated = [...prev, newSale];
      LocalStorageDB.set(STORAGE_KEYS.SALES, updated);
      return updated;
    });
  };

  const updateSale = (id: string, saleData: Partial<Sale>) => {
    setSales(prev => {
      const oldSale = prev.find(s => s.id === id);
      const updated = prev.map(sale => 
        sale.id === id ? { ...sale, ...saleData } : sale
      );
      
      // Handle inventory adjustments when sale status changes
      const updatedSale = updated.find(s => s.id === id);
      if (oldSale && updatedSale) {
        // If sale was completed and now cancelled/pending, restore inventory
        if (oldSale.status === 'completed' && updatedSale.status !== 'completed') {
          setProducts(prevProducts => {
            const restoredProducts = prevProducts.map(product => {
              const saleItem = updatedSale.items.find(item => item.productId === product.id);
              if (saleItem) {
                const newStock = product.inStock + saleItem.quantity;
                return {
                  ...product,
                  inStock: newStock,
                  valueOnHand: calculateValueOnHand(product.purchasePrice, newStock)
                };
              }
              return product;
            });
            LocalStorageDB.set(STORAGE_KEYS.PRODUCTS, restoredProducts);
            return restoredProducts;
          });
        }
        // If sale was not completed and now completed, reduce inventory
        else if (oldSale.status !== 'completed' && updatedSale.status === 'completed') {
          setProducts(prevProducts => {
            const reducedProducts = prevProducts.map(product => {
              const saleItem = updatedSale.items.find(item => item.productId === product.id);
              if (saleItem) {
                const newStock = Math.max(0, product.inStock - saleItem.quantity);
                return {
                  ...product,
                  inStock: newStock,
                  valueOnHand: calculateValueOnHand(product.purchasePrice, newStock)
                };
              }
              return product;
            });
            LocalStorageDB.set(STORAGE_KEYS.PRODUCTS, reducedProducts);
            return reducedProducts;
          });
        }
      }
      
      LocalStorageDB.set(STORAGE_KEYS.SALES, updated);
      return updated;
    });
  };

  const addPurchase = (purchaseData: Omit<Purchase, 'id'>) => {
    const newPurchase: Purchase = {
      ...purchaseData,
      id: generateId()
    };
    
    // Update inventory for received purchases
    if (newPurchase.status === 'received') {
      setProducts(prev => {
        const updated = prev.map(product => {
          if (product.id === newPurchase.productId) {
            const newStock = product.inStock + newPurchase.quantity;
            return {
              ...product,
              inStock: newStock,
              valueOnHand: calculateValueOnHand(product.purchasePrice, newStock)
            };
          }
          return product;
        });
        LocalStorageDB.set(STORAGE_KEYS.PRODUCTS, updated);
        return updated;
      });
    }
    
    setPurchases(prev => {
      const updated = [...prev, newPurchase];
      LocalStorageDB.set(STORAGE_KEYS.PURCHASES, updated);
      return updated;
    });
  };

  const updatePurchase = (id: string, purchaseData: Partial<Purchase>) => {
    setPurchases(prev => {
      const oldPurchase = prev.find(p => p.id === id);
      const updated = prev.map(purchase => 
        purchase.id === id ? { ...purchase, ...purchaseData } : purchase
      );
      
      // Handle inventory adjustments when purchase status changes
      const updatedPurchase = updated.find(p => p.id === id);
      if (oldPurchase && updatedPurchase) {
        // If purchase was received and now cancelled/pending, reduce inventory
        if (oldPurchase.status === 'received' && updatedPurchase.status !== 'received') {
          setProducts(prevProducts => {
            const reducedProducts = prevProducts.map(product => {
              if (product.id === updatedPurchase.productId) {
                const newStock = Math.max(0, product.inStock - updatedPurchase.quantity);
                return {
                  ...product,
                  inStock: newStock,
                  valueOnHand: calculateValueOnHand(product.purchasePrice, newStock)
                };
              }
              return product;
            });
            LocalStorageDB.set(STORAGE_KEYS.PRODUCTS, reducedProducts);
            return reducedProducts;
          });
        }
        // If purchase was not received and now received, increase inventory
        else if (oldPurchase.status !== 'received' && updatedPurchase.status === 'received') {
          setProducts(prevProducts => {
            const increasedProducts = prevProducts.map(product => {
              if (product.id === updatedPurchase.productId) {
                const newStock = product.inStock + updatedPurchase.quantity;
                return {
                  ...product,
                  inStock: newStock,
                  valueOnHand: calculateValueOnHand(product.purchasePrice, newStock)
                };
              }
              return product;
            });
            LocalStorageDB.set(STORAGE_KEYS.PRODUCTS, increasedProducts);
            return increasedProducts;
          });
        }
      }
      
      LocalStorageDB.set(STORAGE_KEYS.PURCHASES, updated);
      return updated;
    });
  };

  const updateBusinessInfo = (info: BusinessInfo) => {
    setBusinessInfo(info);
    LocalStorageDB.set(STORAGE_KEYS.BUSINESS_INFO, info);
  };

  const value: InventoryContextType = {
    products,
    customers,
    suppliers,
    purchases,
    sales,
    businessInfo,
    addProduct,
    updateProduct,
    deleteProduct,
    addCustomer,
    updateCustomer,
    deleteCustomer,
    addSupplier,
    updateSupplier,
    deleteSupplier,
    addPurchase,
    updatePurchase,
    addSale,
    updateSale,
    updateBusinessInfo
  };

  return (
    <InventoryContext.Provider value={value}>
      {children}
    </InventoryContext.Provider>
  );
};

export const useInventory = () => {
  const context = useContext(InventoryContext);
  if (context === undefined) {
    throw new Error('useInventory must be used within an InventoryProvider');
  }
  return context;
};