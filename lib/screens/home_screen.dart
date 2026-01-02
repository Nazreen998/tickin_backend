import 'package:flutter/material.dart';
import 'create_order_screen.dart';
import 'my_orders_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int idx = 0;

  @override
  Widget build(BuildContext context) {
    final pages = const [
      CreateOrderScreen(),
      MyOrdersScreen(),
    ];

    return Scaffold(
      body: pages[idx],
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: idx,
        onTap: (v) => setState(() => idx = v),
        items: const [
          BottomNavigationBarItem(icon: Icon(Icons.add_shopping_cart), label: "Create"),
          BottomNavigationBarItem(icon: Icon(Icons.list_alt), label: "Orders"),
        ],
      ),
    );
  }
}
