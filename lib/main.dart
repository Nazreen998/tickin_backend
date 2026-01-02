import 'package:flutter/material.dart';

import 'storage/token_store.dart';
import 'api/http_client.dart';

import 'api/auth_api.dart';
import 'api/orders_api.dart';
import 'api/sales_api.dart';
import 'api/driver_api.dart';
import 'api/timeline_api.dart';
import 'api/trips_api.dart';
import 'api/slots_api.dart';
import 'api/goals_api.dart';

import 'screens/login_screen.dart';

void main() {
  runApp(const TickinApp());
}

class TickinAppScope extends InheritedWidget {
  final TokenStore tokenStore;
  final HttpClient httpClient;

  final AuthApi authApi;
  final OrdersApi ordersApi;
  final SalesApi salesApi;
  final DriverApi driverApi;
  final TimelineApi timelineApi;
  final TripsApi tripsApi;
  final SlotsApi slotsApi;
  final GoalsApi goalsApi; // ✅ ADD

  const TickinAppScope({
    super.key,
    required super.child,
    required this.tokenStore,
    required this.httpClient,
    required this.authApi,
    required this.ordersApi,
    required this.salesApi,
    required this.driverApi,
    required this.timelineApi,
    required this.tripsApi,
    required this.slotsApi,
    required this.goalsApi, // ✅ ADD
  });

  static TickinAppScope of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<TickinAppScope>();
    assert(scope != null, "TickinAppScope not found");
    return scope!;
  }

  @override
  bool updateShouldNotify(TickinAppScope oldWidget) => false;
}

class TickinApp extends StatelessWidget {
  const TickinApp({super.key});

  @override
  Widget build(BuildContext context) {
    final tokenStore = TokenStore();
    final httpClient = HttpClient(tokenStore);

    final authApi = AuthApi(httpClient);
    final ordersApi = OrdersApi(httpClient);
    final salesApi = SalesApi(httpClient);
    final driverApi = DriverApi(httpClient);
    final timelineApi = TimelineApi(httpClient);
    final tripsApi = TripsApi(httpClient);
    final slotsApi = SlotsApi(httpClient);
    final goalsApi = GoalsApi(httpClient); // ✅ ADD

    return TickinAppScope(
      tokenStore: tokenStore,
      httpClient: httpClient,
      authApi: authApi,
      ordersApi: ordersApi,
      salesApi: salesApi,
      driverApi: driverApi,
      timelineApi: timelineApi,
      tripsApi: tripsApi,
      slotsApi: slotsApi,
      goalsApi: goalsApi, // ✅ ADD
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        title: 'Tickin',
        theme: ThemeData(useMaterial3: true),
        home: LoginScreen(authApi: authApi, tokenStore: tokenStore),
      ),
    );
  }
}
