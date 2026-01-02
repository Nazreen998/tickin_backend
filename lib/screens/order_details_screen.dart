import 'package:flutter/material.dart';
import '../main.dart';

class OrderDetailsScreen extends StatefulWidget {
  final String orderId;
  const OrderDetailsScreen({super.key, required this.orderId});

  @override
  State<OrderDetailsScreen> createState() => _OrderDetailsScreenState();
}

class _OrderDetailsScreenState extends State<OrderDetailsScreen> {
  late Future<Map<String, dynamic>> future;

  @override
  void initState() {
    super.initState();
    future = TickinAppScope.of(context).ordersApi.getOrderById(widget.orderId);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text("Order ${widget.orderId}")),
      body: FutureBuilder<Map<String, dynamic>>(
        future: future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snap.hasError) return Center(child: Text(snap.error.toString()));

          final order =
              (snap.data!["order"] ?? snap.data!) as Map<String, dynamic>;
          final items = (order["items"] ?? []) as List;

          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Text("Status: ${order["status"]}",
                  style: const TextStyle(fontWeight: FontWeight.bold)),
              Text(
                  "Distributor: ${order["distributorName"] ?? order["distributorId"]}"),
              Text("Total: ${order["totalAmount"]}"),
              const Divider(),
              const Text("Items",
                  style: TextStyle(fontWeight: FontWeight.bold)),
              ...items.map((e) {
                final m = (e as Map).cast<String, dynamic>();
                return Card(
                  child: ListTile(
                    title: Text(m["name"] ?? m["productId"]),
                    subtitle: Text(
                        "Qty: ${m["qty"]} | Price: ${m["price"]}"),
                  ),
                );
              }),
            ],
          );
        },
      ),
    );
  }
}
