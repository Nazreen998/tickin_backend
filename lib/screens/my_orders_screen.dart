import 'dart:convert';
import 'package:flutter/material.dart';
import '../main.dart';
import 'order_details_screen.dart';

class MyOrdersScreen extends StatefulWidget {
  const MyOrdersScreen({super.key});

  @override
  State<MyOrdersScreen> createState() => _MyOrdersScreenState();
}

class _MyOrdersScreenState extends State<MyOrdersScreen> {
  late Future<List<Map<String, dynamic>>> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  void _reload() {
    // ❌ async inside setState removed
    setState(() {
      _future = _load();
    });
  }

  Future<List<Map<String, dynamic>>> _load() async {
    final scope = TickinAppScope.of(context);

    final userJson = await scope.tokenStore.getUserJson();
    if (userJson == null) throw Exception("User not logged in");

    final role = _extractRole(userJson);
    Map<String, dynamic> res;

    if (role == "MANAGER" || role == "MASTER") {
      res = await scope.ordersApi.all();
    } else if (role == "SALES OFFICER") {
      res = await scope.ordersApi.my();
    } else {
      return [];
    }

    final list = (res["orders"] ?? []) as List;
    return list.map((e) => Map<String, dynamic>.from(e)).toList();
  }

  String _extractRole(String userJson) {
    final m = jsonDecode(userJson);
    return (m["role"] ?? "")
        .toString()
        .toUpperCase()
        .replaceAll("_", " ");
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("My Orders"),
        actions: [
          IconButton(onPressed: _reload, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: FutureBuilder<List<Map<String, dynamic>>>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }

          if (snap.hasError) {
            return Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(snap.error.toString()),
                  const SizedBox(height: 8),
                  ElevatedButton(onPressed: _reload, child: const Text("Retry")),
                ],
              ),
            );
          }

          final orders = snap.data ?? [];
          if (orders.isEmpty) {
            return const Center(child: Text("No orders"));
          }

          return ListView.separated(
            itemCount: orders.length,
            // ignore: unnecessary_underscores
            separatorBuilder: (_, __) => const Divider(),
            itemBuilder: (_, i) {
              final o = orders[i];
              return ListTile(
                title: Text(o["distributorName"] ?? o["distributorId"]),
                subtitle: Text(
                    "Order: ${o["orderId"]} | ${o["status"]} | ₹${o["totalAmount"]}"),
                onTap: () {
                  Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) =>
                          OrderDetailsScreen(orderId: o["orderId"]),
                    ),
                  );
                },
              );
            },
          );
        },
      ),
    );
  }
}
