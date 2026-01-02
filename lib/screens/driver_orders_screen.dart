import 'package:flutter/material.dart';
import '../main.dart';

class DriverOrdersScreen extends StatefulWidget {
  final String driverId; // pass from logged-in user.mobile
  const DriverOrdersScreen({super.key, required this.driverId});

  @override
  State<DriverOrdersScreen> createState() => _DriverOrdersScreenState();
}

class _DriverOrdersScreenState extends State<DriverOrdersScreen> {
  late Future<List<Map<String, dynamic>>> future;

  @override
  void initState() {
    super.initState();
    future = TickinAppScope.of(context).driverApi.getDriverOrders(widget.driverId);
  }

  void reload() {
    setState(() {
      future = TickinAppScope.of(context).driverApi.getDriverOrders(widget.driverId);
    });
  }

  Future<void> _update(String orderId, String status) async {
    final api = TickinAppScope.of(context).driverApi;
    try {
      await api.updateStatus(orderId: orderId, status: status);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("✅ $status")));
      reload();
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("Driver Orders"), actions: [
        IconButton(onPressed: reload, icon: const Icon(Icons.refresh))
      ]),
      body: FutureBuilder<List<Map<String, dynamic>>>(
        future: future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snap.hasError) {
            return Center(child: Text(snap.error.toString()));
          }

          final orders = snap.data ?? [];
          if (orders.isEmpty) return const Center(child: Text("No active orders"));

          return ListView.builder(
            itemCount: orders.length,
            itemBuilder: (context, i) {
              final o = orders[i];
              final orderId = (o["orderId"] ?? "").toString();
              final status = (o["status"] ?? "").toString();
              final dist = (o["distributorName"] ?? o["distributorId"] ?? "").toString();

              return Card(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text("Order: $orderId", style: const TextStyle(fontWeight: FontWeight.bold)),
                      Text("Distributor: $dist"),
                      Text("Status: $status"),
                      const SizedBox(height: 10),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          ElevatedButton(
                            onPressed: () => _update(orderId, "DRIVER_STARTED"),
                            child: const Text("Start"),
                          ),
                          ElevatedButton(
                            onPressed: () => _update(orderId, "DRIVER_REACHED_DISTRIBUTOR"),
                            child: const Text("Reached"),
                          ),
                          ElevatedButton(
                            onPressed: () => _update(orderId, "UNLOAD_START"),
                            child: const Text("Unload Start"),
                          ),
                          ElevatedButton(
                            onPressed: () => _update(orderId, "UNLOAD_END"),
                            child: const Text("Unload End"),
                          ),
                          ElevatedButton(
                            onPressed: () => _update(orderId, "WAREHOUSE_REACHED"),
                            child: const Text("Warehouse"),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              );
            },
          );
        },
      ),
    );
  }
}
